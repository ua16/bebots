import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Stream } from "effect";
import type { Bot, Conversation, ConversationSession, Message, Run } from "@bebots/domain";
import { asBotId, asConversationId } from "@bebots/domain";
import { BotReplyRecorder, ConversationRunCoordinator } from "./conversation-run-coordinator.js";
import { ConversationService, ConversationSessionService } from "./conversation-service.js";
import { NotFoundError } from "./errors.js";
import { RunService } from "./run-service.js";
import type {
  BotRepository,
  BotWorkspace,
  Clock,
  ConversationRepository,
  ConversationSessionRepository,
  IdGenerator,
  MessageRepository,
  RunRepository,
} from "./repositories.js";
import type { AgentRuntime, RuntimeError, RunHandle, RunRequest, RuntimeEvent } from "./runtime.js";

// ---------------------------------------------------------------------------
// In-memory fakes (mirrors the repository contracts exactly)
// ---------------------------------------------------------------------------

function makeConversationRepo(): ConversationRepository {
  const store = new Map<string, Conversation>();
  return {
    create: (c) => {
      store.set(String(c.id), c);
      return Effect.succeed(c);
    },
    findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
    findAll: () => Effect.succeed([...store.values()]),
    update: (c) => Effect.succeed(c),
    delete: (id) => {
      store.delete(String(id));
      return Effect.void;
    },
  };
}

function makeMessageRepo(): MessageRepository {
  const store = new Map<string, Message>();
  return {
    create: (m) => {
      store.set(String(m.id), m);
      return Effect.succeed(m);
    },
    findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
    findByConversation: (conversationId, options) => {
      const list = [...store.values()]
        .filter((m) => String(m.conversationId) === String(conversationId))
        .sort((a, b) => a.createdAt - b.createdAt);
      return Effect.succeed(options?.limit !== undefined ? list.slice(0, options.limit) : list);
    },
    findAll: () => Effect.succeed([...store.values()]),
    update: (m) => Effect.succeed(m),
    delete: (id) => {
      store.delete(String(id));
      return Effect.void;
    },
  };
}

function makeSessionRepo(): ConversationSessionRepository {
  const sessions = new Map<string, ConversationSession>();
  return {
    create: (s) => {
      sessions.set(String(s.id), s);
      return Effect.succeed(s);
    },
    findById: (id) => Effect.succeed(sessions.get(String(id)) ?? null),
    findByConversation: (conversationId) =>
      Effect.succeed(
        [...sessions.values()].filter((s) => String(s.conversationId) === String(conversationId)),
      ),
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
        [...sessions.values()].filter((s) => !filter?.status || s.status === filter.status),
      ),
    update: (s) => Effect.succeed(s),
    delete: (id) => {
      sessions.delete(String(id));
      return Effect.void;
    },
  };
}

const bot: Bot = {
  id: asBotId("bot-1"),
  name: "Bot One",
  description: "",
  persona: "",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
};

const botRepo: BotRepository = {
  create: (b) => Effect.succeed(b),
  findById: (id) => Effect.succeed(String(id) === "bot-1" ? bot : null),
  findAll: () => Effect.succeed([bot]),
  update: (b) => Effect.succeed(b),
  delete: () => Effect.void,
};

const workspace: BotWorkspace = {
  root: "/tmp/bots",
  ensureHome: () => Effect.succeed("/tmp/bots"),
  writePersona: () => Effect.void,
  homePath: () => "/tmp/bots/bot-1",
};

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

function makeRuntime(overrides: Partial<Pick<AgentRuntime, "startRun">> = {}): AgentRuntime {
  const runtime: AgentRuntime = {
    id: "fake",
    capabilities: { streaming: false, resumableSessions: false, cancellation: false },
    startRun: (_request: RunRequest) =>
      Effect.succeed({ runId: "rt-1", sessionId: "sess-1" } satisfies RunHandle),
    cancelRun: () => Effect.void,
    streamEvents: () => Stream.fromIterable<RuntimeEvent>([{ _tag: "completed", summary: "done" }]),
    getResult: () => Effect.succeed({ exitCode: 0, summary: "done" }),
  };
  return { ...runtime, ...overrides };
}

interface TestEnv {
  readonly coordinator: ConversationRunCoordinator;
  readonly conversationService: ConversationService;
  readonly sessions: ConversationSessionService;
}

/** `participantBots` controls which participants the fake bot repo knows. */
function makeEnv(participants: readonly string[], runtime: AgentRuntime): TestEnv {
  const fixedClock: Clock = { now: () => 1_000 };
  const ids: IdGenerator = { generate: () => "fixed-id" };
  const conversationService = new ConversationService({
    conversationRepo: makeConversationRepo(),
    messageRepo: makeMessageRepo(),
    clock: fixedClock,
    ids,
  });
  const sessions = new ConversationSessionService({
    sessionRepo: makeSessionRepo(),
    clock: fixedClock,
    ids,
  });
  const runService = new RunService(
    makeRunRepo(),
    botRepo,
    workspace,
    runtime,
    fixedClock,
    ids,
    sessions,
  );
  const coordinator = new ConversationRunCoordinator({
    conversationService,
    runService,
    botRepo,
  });
  return { coordinator, conversationService, sessions };
}

async function seedConversation(env: TestEnv, participants: readonly string[]): Promise<void> {
  await Effect.runPromise(
    env.conversationService.createConversation({ title: "thread", participants }),
  );
}

// The seeded conversation id: ids.generate() is fixed in this environment.
const conversationId = "fixed-id";

describe("ConversationRunCoordinator", () => {
  it("triggers a participant-bot run on a human message and links it", async () => {
    const env = makeEnv(["bot-1", "human"], makeRuntime());
    await seedConversation(env, ["bot-1", "human"]);

    const result = await Effect.runPromise(
      env.coordinator.sendMessage({ conversationId, content: "hello bot" }),
    );

    expect(result.message.content).toBe("hello bot");
    expect(result.run).not.toBeNull();
    expect(result.run?.botId).toBe("bot-1");
    expect(result.run?.conversationId).toBe(asConversationId(conversationId));
    expect(result.run?.triggerType).toBe("message");
    expect(result.run?.prompt).toBe("hello bot");
    // The reply run's session was captured for later resumption (issue #15).
    const sessionList = await Effect.runPromise(env.sessions.listSessions({ conversationId }));
    expect(sessionList[0]?.runtimeSessionId).toBe("sess-1");
  });

  it("does not trigger for bot or system messages", async () => {
    for (const senderType of ["bot", "system"] as const) {
      const env = makeEnv(["bot-1", "human"], makeRuntime());
      await seedConversation(env, ["bot-1", "human"]);
      const result = await Effect.runPromise(
        env.coordinator.sendMessage({ conversationId, content: "onward", senderType }),
      );
      expect(result.run).toBeNull();
      expect(result.message.senderType).toBe(senderType);
    }
  });

  it("stores a message without triggering when no bot participates", async () => {
    const env = makeEnv([], makeRuntime());
    await seedConversation(env, ["human"]);
    const result = await Effect.runPromise(
      env.coordinator.sendMessage({ conversationId, content: "just us" }),
    );
    expect(result.run).toBeNull();
  });

  it("fails typed when the conversation does not exist", async () => {
    const env = makeEnv(["bot-1", "human"], makeRuntime());
    const exit = await Effect.runPromiseExit(
      env.coordinator.sendMessage({ conversationId: "missing", content: "hi" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(NotFoundError);
    }
  });

  it("keeps the message delivered when the reply run cannot start", async () => {
    const failing: RuntimeError = { _tag: "RuntimeError", message: "boom" };
    const env = makeEnv(["bot-1", "human"], makeRuntime({ startRun: () => Effect.fail(failing) }));
    await seedConversation(env, ["bot-1", "human"]);
    const result = await Effect.runPromise(
      env.coordinator.sendMessage({ conversationId, content: "hello" }),
    );
    expect(result.message.content).toBe("hello");
    expect(result.run).toBeNull();
  });
});

describe("BotReplyRecorder", () => {
  it("persists the run summary as a bot reply from the run's bot", async () => {
    const env = makeEnv([], makeRuntime());
    const recorder = new BotReplyRecorder({ conversationService: env.conversationService });
    await Effect.runPromise(recorder.recordBotReply(conversationId, "bot-1", "the answer"));
    const thread = await Effect.runPromise(env.conversationService.listMessages(conversationId));
    expect(thread).toHaveLength(1);
    expect(thread[0]?.senderType).toBe("bot");
    expect(thread[0]?.senderId).toBe("bot-1");
    expect(thread[0]?.content).toBe("the answer");
  });
});
