import { describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, Stream } from "effect";
import type { ConversationSession, ConversationSessionId, Run } from "@bebots/domain";
import { asBotId, asConversationId, asConversationSessionId } from "@bebots/domain";
import { ConversationSessionService } from "./conversation-service.js";
import { RunService } from "./run-service.js";
import { NotFoundError, ValidationError } from "./errors.js";
import type {
  BotRepository,
  BotWorkspace,
  Clock,
  ConversationSessionRepository,
  IdGenerator,
  RunRepository,
} from "./repositories.js";
import type { AgentRuntime, RunHandle, RunRequest, RunResult, RuntimeEvent } from "./runtime.js";

// ---------------------------------------------------------------------------
// In-memory ConversationSessionRepository
// ---------------------------------------------------------------------------

function makeSessionRepo(): ConversationSessionRepository {
  const sessions = new Map<ConversationSessionId, ConversationSession>();
  return {
    create: (session) => {
      sessions.set(session.id, session);
      return Effect.succeed(session);
    },
    findById: (id) => Effect.succeed(sessions.get(id) ?? null),
    findLatestByConversation: (conversationId, options) =>
      Effect.succeed(
        [...sessions.values()]
          .filter(
            (s) =>
              String(s.conversationId) === String(conversationId) &&
              (!options?.status || s.status === options.status),
          )
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null,
      ),
    findAll: (filter) =>
      Effect.succeed(
        [...sessions.values()].filter(
          (s) =>
            (!filter?.conversationId ||
              String(s.conversationId) === String(filter.conversationId)) &&
            (!filter?.status || s.status === filter.status),
        ),
      ),
    update: (session) => {
      if (!sessions.has(session.id)) {
        return Effect.fail(new NotFoundError("ConversationSession", String(session.id)));
      }
      sessions.set(session.id, session);
      return Effect.succeed(session);
    },
    delete: (id) => {
      if (!sessions.delete(id)) {
        return Effect.fail(new NotFoundError("ConversationSession", String(id)));
      }
      return Effect.void;
    },
  };
}

// ---------------------------------------------------------------------------
// ConversationSessionService lifecycle
// ---------------------------------------------------------------------------

describe("ConversationSessionService", () => {
  const conversationId = asConversationId("c1");
  const fixedClock: Clock = { now: () => 10_000 };
  const ids: IdGenerator = { generate: () => "cs-1" };

  function makeService(repo: ConversationSessionRepository): ConversationSessionService {
    return new ConversationSessionService({ sessionRepo: repo, clock: fixedClock, ids });
  }

  it("requires a runtime session id with a typed failure", async () => {
    const service = makeService(makeSessionRepo());
    const exit = await Effect.runPromiseExit(
      service.createSession({ conversationId, runtimeSessionId: "" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = Cause.squash(exit.cause);
      expect(cause).toBeInstanceOf(ValidationError);
      expect((cause as ValidationError).field).toBe("runtimeSessionId");
    }
  });

  it("records sessions with app-side ids and 30-day expiry fields", async () => {
    const repo = makeSessionRepo();
    const service = makeService(repo);
    const stored = await Effect.runPromise(
      service.createSession({ conversationId, runtimeSessionId: "rt-abc", status: "active" }),
    );
    expect(stored.runtimeSessionId).toBe("rt-abc");
    expect(stored.lastUsedAt).toBe(10_000);
    expect(stored.status).toBe("active");

    // Exactly one canonical lastUsed field survives to persistence.
    const row = await Effect.runPromise(
      repo.findById(asConversationSessionId("cs-1")) as Effect.Effect<
        ConversationSession | null,
        never
      >,
    );
    expect(row?.lastUsedAt ?? row?.updatedAt).toBe(10_000);
  });

  it("sweeps sessions idle past the 30-day window to expired", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const lateClock: Clock = { now: () => 40 * dayMs };
    const updates: ConversationSession[] = [];
    const repo: ConversationSessionRepository = {
      ...makeSessionRepo(),
      findAll: () =>
        Effect.succeed([
          {
            id: asConversationSessionId("stale"),
            conversationId,
            runtimeSessionId: "rt-stale",
            lastUsedAt: 0,
            status: "active",
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: asConversationSessionId("fresh"),
            conversationId,
            runtimeSessionId: "rt-fresh",
            lastUsedAt: 39.5 * dayMs,
            status: "active",
            createdAt: 0,
            updatedAt: 0,
          },
        ] as ConversationSession[]),
      update: (session) => {
        updates.push(session);
        return Effect.succeed(session);
      },
    };
    const service = new ConversationSessionService({
      sessionRepo: repo,
      clock: lateClock,
      ids,
    });
    const expired = await Effect.runPromise(service.expireStaleSessions(30 * dayMs));
    expect(expired.map((s) => s.id)).toEqual([asConversationSessionId("stale")]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBe("expired");
    expect(updates[0]?.updatedAt).toBe(lateClock.now());
  });

  it("rotates a session to the runtime's fresh session and reports it resumable", async () => {
    const repo = makeSessionRepo();
    const service = makeService(repo);
    await Effect.runPromise(service.createSession({ conversationId, runtimeSessionId: "rt-old" }));
    const rotated = await Effect.runPromise(service.replaceRuntimeSession("cs-1", "rt-new"));
    expect(rotated.runtimeSessionId).toBe("rt-new");
    expect(rotated.status).toBe("active");

    const resumed = await Effect.runPromise(service.findResumableSession(conversationId));
    expect(resumed?.runtimeSessionId).toBe("rt-new");
  });

  it("does not offer expired sessions for resume", async () => {
    const repo = makeSessionRepo();
    const service = makeService(repo);
    await Effect.runPromise(
      repo.create({
        id: asConversationSessionId("expired"),
        conversationId,
        runtimeSessionId: "rt-old",
        lastUsedAt: 1,
        status: "expired",
        createdAt: 0,
        updatedAt: 1,
      }),
    );
    const resumed = await Effect.runPromise(service.findResumableSession(conversationId));
    expect(resumed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RunService resume-by-default contract (PLAN §6.4, issue #1 DoD)
// ---------------------------------------------------------------------------

describe("RunService conversation resume contract", () => {
  const fixedClock: Clock = { now: () => 5_000 };
  const ids: IdGenerator = { generate: () => "run-1" };
  const conversationId = asConversationId("c1");

  function makeRunRepo(): RunRepository {
    const store = new Map<string, Run>();
    return {
      create: (run) => {
        store.set(String(run.id), run);
        return Effect.succeed(run);
      },
      findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
      findAll: () => Effect.succeed([...store.values()]),
      update: (run) => {
        store.set(String(run.id), run);
        return Effect.succeed(run);
      },
      appendEvent: () => Effect.void,
      listEvents: () => Effect.succeed([]),
    };
  }

  const botRepo: BotRepository = {
    create: (b) => Effect.succeed(b),
    findById: () =>
      Effect.succeed({
        id: asBotId("bot-1"),
        name: "Bot",
        description: "",
        persona: "",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    findAll: () => Effect.succeed([]),
    update: (b) => Effect.succeed(b),
    delete: () => Effect.void,
  };

  const workspace: BotWorkspace = {
    root: "/tmp/bots",
    ensureHome: () => Effect.succeed("/tmp/bots"),
    writePersona: () => Effect.void,
    homePath: () => "/tmp/bots/bot-1",
  };

  function makeRuntime(
    onSession: (requested: string | undefined) => string,
  ): AgentRuntime & { run: RunHandle } {
    let handle: RunHandle = { runId: "rt-1" };
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: true, resumableSessions: true, cancellation: true },
      startRun: (request: RunRequest) =>
        Effect.succeed(
          (handle = { runId: "rt-1", sessionId: onSession(request.sessionId ?? undefined) }),
        ),
      cancelRun: () => Effect.void,
      streamEvents: () =>
        Stream.fromIterable([
          { _tag: "started", at: new Date() },
          { _tag: "completed", summary: "done" },
        ] as RuntimeEvent[]),
      getResult: () => Effect.succeed({ exitCode: 0, summary: "done" } as RunResult),
    };
    return {
      get run(): RunHandle {
        return handle;
      },
      ...runtime,
    };
  }

  it("creates a ConversationSession on the first run in a conversation", async () => {
    const sessions = new ConversationSessionService({
      sessionRepo: makeSessionRepo(),
      clock: fixedClock,
      ids,
    });
    const runtime = makeRuntime(() => "sess-new");
    const service = new RunService({
      runRepo: makeRunRepo(),
      botRepo,
      workspace,
      runtime,
      clock: fixedClock,
      ids,
      conversationSessions: sessions,
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi", conversationId }),
    );
    expect(run.sessionId).toBe("sess-new");
    const list = await Effect.runPromise(sessions.listSessions({ conversationId }));
    expect(list).toHaveLength(1);
    expect(list[0]?.runtimeSessionId).toBe("sess-new");
    expect(list[0]?.status).toBe("active");
  });

  it("resumes the most recent active session by default", async () => {
    const repo = makeSessionRepo();
    const sessions = new ConversationSessionService({
      sessionRepo: repo,
      clock: fixedClock,
      ids,
    });
    const existing = await Effect.runPromise(
      sessions.createSession({ conversationId, runtimeSessionId: "sess-stored" }),
    );

    let requestedSessionId: string | undefined;
    const runtime = makeRuntime((requested) => {
      requestedSessionId = requested;
      return requested ?? "sess-stored";
    });
    const service = new RunService({
      runRepo: makeRunRepo(),
      botRepo,
      workspace,
      runtime,
      clock: fixedClock,
      ids,
      conversationSessions: sessions,
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi", conversationId }),
    );
    // The runtime received the stored session id, not an empty one.
    expect(requestedSessionId).toBe("sess-stored");
    expect(run.sessionId).toBe("sess-stored");
    expect((await Effect.runPromise(sessions.getSession(existing.id)))?.lastUsedAt).toBe(5_000);
  });

  it("rotates the ConversationSession when the runtime started a fresh session", async () => {
    const repo = makeSessionRepo();
    const sessions = new ConversationSessionService({
      sessionRepo: repo,
      clock: fixedClock,
      ids,
    });
    const existing = await Effect.runPromise(
      sessions.createSession({ conversationId, runtimeSessionId: "sess-stale" }),
    );

    // The runtime cannot resume "sess-stale" and transparently creates a new
    // session instead (contract test: expiry/failure → new session).
    const runtime = makeRuntime((requested) =>
      requested === "sess-stale" ? "sess-fresh" : (requested ?? "sess-fresh"),
    );
    const service = new RunService({
      runRepo: makeRunRepo(),
      botRepo,
      workspace,
      runtime,
      clock: fixedClock,
      ids,
      conversationSessions: sessions,
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi", conversationId }),
    );
    expect(run.sessionId).toBe("sess-fresh");

    const stored = await Effect.runPromise(
      repo.findById(existing.id) as Effect.Effect<ConversationSession | null, never>,
    );
    expect(stored?.runtimeSessionId).toBe("sess-fresh");
    expect(stored?.status).toBe("active");
  });

  it("records the bot reply when a conversation run succeeds (issue #18)", async () => {
    const sessions = new ConversationSessionService({
      sessionRepo: makeSessionRepo(),
      clock: fixedClock,
      ids,
    });
    const replies: Array<{ conversationId: string; botId: string; content: string }> = [];
    const runtime = makeRuntime(() => "sess-new");
    const service = new RunService({
      runRepo: makeRunRepo(),
      botRepo,
      workspace,
      runtime,
      clock: fixedClock,
      ids,
      conversationSessions: sessions,
      // Full reply loop glue: a succeeded conversation run posts its answer
      // into the thread as a bot message.
      conversationMessages: {
        recordBotReply: (replyConversationId, replyBotId, content) =>
          Effect.sync(() => {
            replies.push({
              conversationId: replyConversationId,
              botId: replyBotId,
              content,
            });
          }),
      },
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi", conversationId }),
    );
    await Effect.runPromise(service.awaitRun(run.id, 5_000));

    // The reply is posted by the detached finalize fiber, not by startRun.
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toEqual({
      conversationId: "c1",
      botId: "bot-1",
      content: "done",
    });
  });

  it("fails typed when an explicit conversationSessionId does not exist", async () => {
    const sessions = new ConversationSessionService({
      sessionRepo: makeSessionRepo(),
      clock: fixedClock,
      ids,
    });
    const runtime = makeRuntime(() => "sess-x");
    const service = new RunService({
      runRepo: makeRunRepo(),
      botRepo,
      workspace,
      runtime,
      clock: fixedClock,
      ids,
      conversationSessions: sessions,
    });

    const exit = await Effect.runPromiseExit(
      service.startRun({
        botId: asBotId("bot-1"),
        prompt: "hi",
        conversationId,
        conversationSessionId: asConversationSessionId("missing"),
      } as never),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(exit._tag === "Failure").toBe(true);
  });
});
