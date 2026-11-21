/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import {
  asBotId,
  asConversationId,
  asFormId,
  asRunId,
  avatarFromBotId,
  encodeAskAnswerMarker,
  parseAskAnswerMarker,
} from "@bebots/domain";
import type { ConversationSession, Form } from "@bebots/domain";
import { RunService } from "./run-service.js";
import { ConversationSessionService } from "./conversation-service.js";
import { AppSettingsService } from "./app-settings.js";
import type {
  BotRepository,
  BotWorkspace,
  Clock,
  ConversationSessionRepository,
  IdGenerator,
  RunRepository,
} from "./repositories.js";
import type {
  AgentRuntime,
  RunHandle,
  RunRequest,
  RunResult,
  RuntimeError,
  RuntimeEvent,
} from "./runtime.js";

describe("RunService", () => {
  it("resolves the run's model from the bot override or the app default", async () => {
    const requests: RunRequest[] = [];
    const store = new Map<string, any>();
    const runRepo: RunRepository = {
      create: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      findById: (id) => Effect.succeed(store.get(id) ?? null),
      findAll: (options) =>
        Effect.succeed(
          [...store.values()].filter(
            (r) =>
              (!options?.botId || String(r.botId) === String(options.botId)) &&
              (!options?.status || r.status === options.status),
          ),
        ),
      update: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      appendEvent: () => Effect.void,
      listEvents: () => Effect.succeed([]),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const bots = new Map([
      [
        "bot-override",
        {
          id: "bot-override",
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
          createdAt: 1,
          updatedAt: 1,
        } as any,
      ],
      [
        "bot-plain",
        {
          id: "bot-plain",
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          avatar: avatarFromBotId("bot-1"),
          createdAt: 1,
          updatedAt: 1,
        } as any,
      ],
      [
        "bot-own-model",
        {
          id: "bot-own-model",
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          model: { providerID: "google", id: "gemini-3-pro" },
          createdAt: 1,
          updatedAt: 1,
        } as any,
      ],
    ]);
    const botRepo: BotRepository = {
      create: (b) => Effect.succeed(b),
      findById: (id) => Effect.succeed(bots.get(String(id)) ?? null),
      findAll: () => Effect.succeed([]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp/bots",
      ensureHome: () => Effect.succeed("/tmp/bots/x"),
      writePersona: () => Effect.void,
      homePath: (id) => `/tmp/bots/${id}`,
      removeHome: () => Effect.void,
    };
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: true, resumableSessions: true, cancellation: true },
      startRun: (req: RunRequest) => {
        requests.push(req);
        return Effect.succeed({ runId: "rt-1", sessionId: "sess-1" } as RunHandle);
      },
      cancelRun: () => Effect.void,
      streamEvents: () =>
        Stream.fromIterable([
          { _tag: "started", at: new Date() },
          { _tag: "completed", summary: "done" },
        ] as RuntimeEvent[]),
      getResult: () =>
        Effect.succeed({ exitCode: 0, summary: "done", sessionId: "sess-1" } as RunResult),
    };
    const clock: Clock = { now: () => 100 };
    const ids: IdGenerator = { generate: () => `run-${requests.length + 1}` };
    // App settings service over a KV store, with a default model set.
    const kv = new Map<string, string>();
    kv.set("default_model", JSON.stringify({ providerID: "openai", id: "gpt-5.1" }));
    const settings = new AppSettingsService({
      get: (key: string) => Effect.succeed(kv.get(key) ?? null),
      set: (key: string, value: string) => Effect.sync(() => void kv.set(key, value)),
    });

    const service = new RunService({
      runRepo,
      botRepo,
      workspace,
      runtime,
      clock,
      ids,
      settings,
    });

    // Bot override wins over the app default.
    await Effect.runPromise(service.startRun({ botId: asBotId("bot-override"), prompt: "hi" }));
    // No bot override → the app default applies.
    await Effect.runPromise(service.startRun({ botId: asBotId("bot-plain"), prompt: "hi" }));
    // Bot without an override still beats the default with its own model.
    await Effect.runPromise(service.startRun({ botId: asBotId("bot-own-model"), prompt: "hi" }));

    // Without a settings store and without a bot override, no model is sent.
    const serviceNoSettings = new RunService({ runRepo, botRepo, workspace, runtime, clock, ids });
    await Effect.runPromise(
      serviceNoSettings.startRun({ botId: asBotId("bot-plain"), prompt: "hi" }),
    );

    expect(requests[0]?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" });
    expect(requests[1]?.model).toEqual({ providerID: "openai", id: "gpt-5.1" });
    expect(requests[2]?.model).toEqual({ providerID: "google", id: "gemini-3-pro" });
    expect(requests[3]?.model).toBeUndefined();
  });

  it("starts a run and completes", async () => {
    const store = new Map<string, any>();
    const events = new Map<string, any[]>();
    const runRepo: RunRepository = {
      create: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      findById: (id) => Effect.succeed(store.get(id) ?? null),
      findAll: () => Effect.succeed([...store.values()]),
      update: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      appendEvent: (runId, event) => {
        const arr = events.get(runId) ?? [];
        arr.push(event);
        events.set(runId, arr);
        return Effect.void;
      },
      listEvents: (runId) =>
        Effect.succeed(
          (events.get(runId) ?? []).map((e) => ({
            tag: e._tag,
            payload: e,
            createdAt: Date.now(),
          })),
        ),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const botRepo: BotRepository = {
      create: (b) => Effect.succeed(b),
      findById: (id) =>
        Effect.succeed({
          id,
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          avatar: avatarFromBotId("bot-1"),
          createdAt: 1,
          updatedAt: 1,
        } as any),
      findAll: () => Effect.succeed([]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp/bots",
      ensureHome: () => Effect.succeed("/tmp/bots/x"),
      writePersona: () => Effect.void,
      homePath: (id) => `/tmp/bots/${id}`,
      removeHome: () => Effect.void,
    };
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: true, resumableSessions: true, cancellation: true },
      startRun: (_req: RunRequest) =>
        Effect.succeed({ runId: "rt-1", sessionId: "sess-1" } as RunHandle),
      cancelRun: () => Effect.void,
      streamEvents: () =>
        Stream.fromIterable([
          { _tag: "started", at: new Date() },
          { _tag: "completed", summary: "done" },
        ] as RuntimeEvent[]),
      getResult: () =>
        Effect.succeed({ exitCode: 0, summary: "done", sessionId: "sess-1" } as RunResult),
    };
    const clock: Clock = { now: () => 100 };
    const ids: IdGenerator = { generate: () => "run-1" };
    const service = new RunService({ runRepo, botRepo, workspace, runtime, clock, ids });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    expect(run.id).toBe("run-1");
    expect(run.status).toBe("running");
    // await completion
    const final = await Effect.runPromise(service.awaitRun(run.id, 5000));
    expect(final?.status).toBe("succeeded");
    expect(final?.summary).toBe("done");
  });

  it("rejects empty prompt", async () => {
    const runRepo: RunRepository = {
      create: (r) => Effect.succeed(r),
      findById: () => Effect.succeed(null),
      findAll: () => Effect.succeed([]),
      update: (r) => Effect.succeed(r),
      appendEvent: () => Effect.void,
      listEvents: () => Effect.succeed([]),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const botRepo: BotRepository = {
      create: (b) => Effect.succeed(b),
      findById: () =>
        Effect.succeed({
          id: asBotId("bot-1"),
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          avatar: avatarFromBotId("bot-1"),
          createdAt: 1,
          updatedAt: 1,
        } as any),
      findAll: () => Effect.succeed([]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp",
      ensureHome: () => Effect.succeed("/tmp"),
      writePersona: () => Effect.void,
      homePath: () => "/tmp",
      removeHome: () => Effect.void,
    };
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: false, resumableSessions: false, cancellation: false },
      startRun: () => Effect.succeed({ runId: "r" } as RunHandle),
      cancelRun: () => Effect.void,
      streamEvents: () => Stream.empty as any,
      getResult: () => Effect.succeed({ exitCode: 0, summary: "" } as RunResult),
    };
    const service = new RunService({
      runRepo,
      botRepo,
      workspace,
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "r1" },
    });
    await expect(
      Effect.runPromise(service.startRun({ botId: asBotId("bot-1"), prompt: "  " })),
    ).rejects.toThrow();
  });

  it("bot not found", async () => {
    const runRepo: RunRepository = {
      create: (r) => Effect.succeed(r),
      findById: () => Effect.succeed(null),
      findAll: () => Effect.succeed([]),
      update: (r) => Effect.succeed(r),
      appendEvent: () => Effect.void,
      listEvents: () => Effect.succeed([]),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const botRepo: BotRepository = {
      create: (b) => Effect.succeed(b),
      findById: () => Effect.succeed(null),
      findAll: () => Effect.succeed([]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp",
      ensureHome: () => Effect.succeed("/tmp"),
      writePersona: () => Effect.void,
      homePath: () => "/tmp",
      removeHome: () => Effect.void,
    };
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: false, resumableSessions: false, cancellation: false },
      startRun: () => Effect.succeed({ runId: "r" } as RunHandle),
      cancelRun: () => Effect.void,
      streamEvents: () => Stream.empty as any,
      getResult: () => Effect.succeed({ exitCode: 0, summary: "" } as RunResult),
    };
    const service = new RunService({
      runRepo,
      botRepo,
      workspace,
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "r1" },
    });
    await expect(
      Effect.runPromise(service.startRun({ botId: asBotId("bot-1"), prompt: "hi" })),
    ).rejects.toThrow();
  });

  it("cancel run", async () => {
    const store = new Map<string, any>();
    const runRepo: RunRepository = {
      create: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      findById: (id) => Effect.succeed(store.get(id) ?? null),
      findAll: () => Effect.succeed([...store.values()]),
      update: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      appendEvent: () => Effect.void,
      listEvents: () => Effect.succeed([]),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const botRepo: BotRepository = {
      create: (b) => Effect.succeed(b),
      findById: () =>
        Effect.succeed({
          id: asBotId("bot-1"),
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          avatar: avatarFromBotId("bot-1"),
          createdAt: 1,
          updatedAt: 1,
        } as any),
      findAll: () => Effect.succeed([]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp",
      ensureHome: () => Effect.succeed("/tmp"),
      writePersona: () => Effect.void,
      homePath: () => "/tmp",
      removeHome: () => Effect.void,
    };
    let cancelled = false;
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: true, resumableSessions: false, cancellation: true },
      startRun: () => Effect.succeed({ runId: "rt-1", sessionId: "s" } as RunHandle),
      cancelRun: () => {
        cancelled = true;
        return Effect.void;
      },
      streamEvents: () => Stream.empty as Stream.Stream<RuntimeEvent, RuntimeError>,
      getResult: () => Effect.succeed({ exitCode: 0, summary: "" } as RunResult),
    };
    // Use a stream that blocks until done? Simpler: stream empty
    const runtime2: AgentRuntime = {
      ...runtime,
      streamEvents: () => Stream.empty as Stream.Stream<RuntimeEvent, RuntimeError>,
      getResult: () => Effect.succeed({ exitCode: 0, summary: "ok" } as RunResult),
    };
    const service = new RunService({
      runRepo,
      botRepo,
      workspace,
      runtime: runtime2,
      clock: { now: () => 1 },
      ids: { generate: () => "run-1" },
    });
    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    const cancelledRun = await Effect.runPromise(service.cancelRun(run.id));
    expect(cancelledRun?.status).toBe("cancelled");
    expect(cancelled).toBe(true);
  });

  it("getRunEvents and listRuns", async () => {
    const store = new Map<string, any>();
    const events = new Map<string, any[]>();
    const runRepo: RunRepository = {
      create: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      findById: (id) => Effect.succeed(store.get(id) ?? null),
      findAll: (opts) =>
        Effect.succeed(
          [...store.values()].filter(
            (r) =>
              (!opts?.botId || r.botId === opts.botId) &&
              (!opts?.status || r.status === opts.status),
          ),
        ),
      update: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      appendEvent: (runId, event) => {
        const arr = events.get(runId) ?? [];
        arr.push(event);
        events.set(runId, arr);
        return Effect.void;
      },
      listEvents: (runId) =>
        Effect.succeed(
          (events.get(runId) ?? []).map((e) => ({ tag: e._tag, payload: e, createdAt: 1 })),
        ),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const botRepo: BotRepository = {
      create: (b) => Effect.succeed(b),
      findById: () =>
        Effect.succeed({
          id: asBotId("bot-1"),
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          avatar: avatarFromBotId("bot-1"),
          createdAt: 1,
          updatedAt: 1,
        } as any),
      findAll: () => Effect.succeed([]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp",
      ensureHome: () => Effect.succeed("/tmp"),
      writePersona: () => Effect.void,
      homePath: () => "/tmp",
      removeHome: () => Effect.void,
    };
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: true, resumableSessions: false, cancellation: false },
      startRun: () => Effect.succeed({ runId: "rt-1", sessionId: "s" } as RunHandle),
      cancelRun: () => Effect.void,
      streamEvents: () =>
        Stream.fromIterable([{ _tag: "progress", message: "x" }] as RuntimeEvent[]),
      getResult: () => Effect.succeed({ exitCode: 1, summary: "fail" } as RunResult),
    };
    const service = new RunService({
      runRepo,
      botRepo,
      workspace,
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "run-1" },
    });
    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const evs = await Effect.runPromise(service.getRunEvents(run.id));
    expect(evs.length).toBeGreaterThan(0);
    const list = await Effect.runPromise(service.listRuns({ botId: asBotId("bot-1") }));
    expect(list).toHaveLength(1);
    const g = await Effect.runPromise(service.getRun(run.id));
    expect(g?.id).toBe(run.id);
  });
});

function makeRunRepo() {
  const store = new Map<string, any>();
  const events = new Map<string, any[]>();
  const repo: RunRepository = {
    create: (run) => {
      store.set(run.id, run);
      return Effect.succeed(run);
    },
    findById: (id) => Effect.succeed(store.get(id) ?? null),
    findAll: () => Effect.succeed([...store.values()]),
    update: (run) => {
      store.set(run.id, run);
      return Effect.succeed(run);
    },
    appendEvent: (runId, event) => {
      const arr = events.get(runId) ?? [];
      arr.push(event);
      events.set(runId, arr);
      return Effect.void;
    },
    listEvents: (runId) =>
      Effect.succeed(
        (events.get(runId) ?? []).map((e) => ({ tag: e._tag, payload: e, createdAt: 1 })),
      ),
    deleteByBot: () => Effect.succeed(0),
    deleteByConversation: () => Effect.succeed(0),
  };
  return { repo, store };
}

function makeBotRepo(found = true): BotRepository {
  return {
    create: (b) => Effect.succeed(b),
    findById: (id) =>
      Effect.succeed(
        found
          ? ({
              id,
              name: "Bot",
              description: "",
              persona: "",
              status: "active",
              avatar: avatarFromBotId("bot-1"),
              createdAt: 1,
              updatedAt: 1,
            } as any)
          : null,
      ),
    findAll: () => Effect.succeed([]),
    update: (b) => Effect.succeed(b),
    delete: () => Effect.void,
  };
}

function makeWorkspace(): BotWorkspace {
  return {
    root: "/tmp/bots",
    ensureHome: () => Effect.succeed("/tmp/bots/x"),
    writePersona: () => Effect.void,
    homePath: (id) => `/tmp/bots/${id}`,
    removeHome: () => Effect.void,
  };
}

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "fake",
    capabilities: { streaming: true, resumableSessions: true, cancellation: true },
    startRun: () => Effect.succeed({ runId: "rt-1", sessionId: "sess-1" } as RunHandle),
    cancelRun: () => Effect.void,
    streamEvents: () => Stream.empty as Stream.Stream<RuntimeEvent, RuntimeError>,
    getResult: () =>
      Effect.succeed({ exitCode: 0, summary: "ok", sessionId: "sess-1" } as RunResult),
    ...overrides,
  };
}

describe("RunService branches", () => {
  it("rejects an invalid generated run id", async () => {
    const service = new RunService({
      runRepo: makeRunRepo().repo,
      botRepo: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime: makeRuntime(),
      clock: { now: () => 1 },
      ids: { generate: () => "   " },
    });
    await expect(
      Effect.runPromise(service.startRun({ botId: asBotId("bot-1"), prompt: "hi" })),
    ).rejects.toThrow();
  });

  it("marks the run failed when the runtime cannot produce a result", async () => {
    const { repo } = makeRunRepo();
    const runtime = makeRuntime({
      getResult: () => Effect.fail({ _tag: "RuntimeError", message: "nope" } as RuntimeError),
    });
    const service = new RunService({
      runRepo: repo,
      botRepo: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "run-fail" },
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const final = await Effect.runPromise(service.getRun(run.id));
    expect(final?.status).toBe("failed");
    expect(final?.error).toBeDefined();
  });

  it("returns the current run when awaitRun times out", async () => {
    const { repo } = makeRunRepo();
    const runtime = makeRuntime({
      getResult: () => Effect.never as Effect.Effect<RunResult, RuntimeError>,
    });
    const service = new RunService({
      runRepo: repo,
      botRepo: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "run-wait" },
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    const waited = await Effect.runPromise(service.awaitRun(run.id, 10));
    expect(waited?.status).toBe("running");
  });

  it("cancels a run without an active handle and returns null for unknown runs", async () => {
    const { repo, store } = makeRunRepo();
    const service = new RunService({
      runRepo: repo,
      botRepo: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime: makeRuntime(),
      clock: { now: () => 1 },
      ids: { generate: () => "run-c" },
    });
    // Seed a run directly so no runtime handle is registered for it.
    store.set("run-seed", {
      id: "run-seed",
      botId: "bot-1",
      triggerType: "manual",
      prompt: "p",
      status: "running",
      timeoutMs: 1,
      createdAt: 1,
      updatedAt: 1,
    });

    const cancelled = await Effect.runPromise(service.cancelRun(asRunId("run-seed")));
    expect(cancelled?.status).toBe("cancelled");

    const missing = await Effect.runPromise(service.cancelRun(asRunId("missing")));
    expect(missing).toBeNull();
  });

  it("rejects a missing prompt and falls back when a session id is omitted", async () => {
    const { repo } = makeRunRepo();
    const runtime = makeRuntime({
      startRun: () => Effect.succeed({ runId: "rt-1" } as RunHandle),
    });
    const service = new RunService({
      runRepo: repo,
      botRepo: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "run-ns" },
    });

    await expect(
      Effect.runPromise(service.startRun({ botId: asBotId("bot-1") } as never)),
    ).rejects.toThrow();

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    expect(run.status).toBe("running");
    expect(run.sessionId).toBeUndefined();
  });

  it("ignores stream errors and still records the result", async () => {
    const { repo } = makeRunRepo();
    const runtime = makeRuntime({
      streamEvents: () =>
        Stream.fail({
          _tag: "RuntimeError",
          message: "stream boom",
        } as RuntimeError) as Stream.Stream<RuntimeEvent, RuntimeError>,
    });
    const service = new RunService({
      runRepo: repo,
      botRepo: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "run-stream" },
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const final = await Effect.runPromise(service.getRun(run.id));
    expect(final?.status).toBe("succeeded");
  });

  it("records the error message when the runtime throws an Error", async () => {
    const { repo } = makeRunRepo();
    const runtime = makeRuntime({
      getResult: () =>
        Effect.tryPromise({
          try: async () => {
            throw new Error("kaboom");
          },
          catch: (cause) => cause as RuntimeError,
        }),
    });
    const service = new RunService({
      runRepo: repo,
      botRepo: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "run-err" },
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const final = await Effect.runPromise(service.getRun(run.id));
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("kaboom");
  });

  it("does not overwrite a run that was cancelled while the runtime failed", async () => {
    const base = makeRunRepo();
    let calls = 0;
    const running = {
      id: asRunId("run-1"),
      botId: asBotId("bot-1"),
      triggerType: "manual" as const,
      prompt: "hi",
      status: "running" as const,
      timeoutMs: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const repo: RunRepository = {
      ...base.repo,
      findById: () => {
        calls += 1;
        return Effect.succeed(calls === 1 ? running : { ...running, status: "cancelled" as const });
      },
    };
    const runtime = makeRuntime({
      getResult: () => Effect.fail({ _tag: "RuntimeError", message: "later" } as RuntimeError),
    });
    const service = new RunService({
      runRepo: repo,
      botRepo: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "run-1" },
    });

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBeGreaterThanOrEqual(2);
    // The cancelled guard short-circuits, so the run is left untouched.
    expect(base.store.get(run.id)?.status).toBe("running");
  });
});

describe("RunService session scoping", () => {
  /**
   * Regression test for cross-bot session leaks (diagnosed from a real trace:
   * two runs in one thread shared the writer's OpenCode session). Resumable
   * sessions must be per (conversation, bot): a second bot's run in the same
   * thread gets a fresh session and must not hijack the first bot's, and the
   * first bot keeps resuming its own.
   */
  function makeSessionRepo(): {
    readonly repo: ConversationSessionRepository;
    readonly rows: Map<string, ConversationSession>;
  } {
    const rows = new Map<string, ConversationSession>();
    return {
      rows,
      repo: {
        create: (s) => {
          rows.set(String(s.id), s);
          return Effect.succeed(s);
        },
        findById: (id) => Effect.succeed(rows.get(String(id)) ?? null),
        findLatestByConversation: (cid, options) =>
          Effect.succeed(
            [...rows.values()]
              .filter(
                (s) =>
                  String(s.conversationId) === String(cid) &&
                  (!options?.status || s.status === options.status) &&
                  (options?.botId === undefined || (s.botId ?? null) === options.botId),
              )
              .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null,
          ),
        findAll: (filter) =>
          Effect.succeed(
            [...rows.values()].filter((s) => !filter?.status || s.status === filter.status),
          ),
        update: (s) => {
          rows.set(String(s.id), s);
          return Effect.succeed(s);
        },
        deleteByConversation: (conversationId) => {
          let removed = 0;
          for (const [id, s] of [...rows]) {
            if (String(s.conversationId) === String(conversationId)) {
              rows.delete(id);
              removed++;
            }
          }
          return Effect.succeed(removed);
        },
        deleteByBot: (botId) => {
          let removed = 0;
          for (const [id, s] of [...rows]) {
            if (s.botId !== null && String(s.botId) === String(botId)) {
              rows.delete(id);
              removed++;
            }
          }
          return Effect.succeed(removed);
        },
        delete: (id) => {
          rows.delete(String(id));
          return Effect.void;
        },
      },
    };
  }

  it("scopes resume sessions per bot inside one conversation", async () => {
    const { repo: sessionsRepo } = makeSessionRepo();
    let sessionTick = 0;
    let sessionSeq = 0;
    const sessions = new ConversationSessionService({
      sessionRepo: sessionsRepo,
      clock: { now: () => 100 + sessionTick++ },
      ids: { generate: () => `cs-${++sessionSeq}` },
    });
    const store = new Map<string, any>();
    const runRepo: RunRepository = {
      create: (r) => {
        store.set(String(r.id), r);
        return Effect.succeed(r);
      },
      findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
      findAll: () => Effect.succeed([...store.values()]),
      update: (r) => {
        store.set(String(r.id), r);
        return Effect.succeed(r);
      },
      appendEvent: () => Effect.void,
      listEvents: () => Effect.succeed([]),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const botRepo: BotRepository = {
      create: (b) => Effect.succeed(b),
      findById: (id) =>
        Effect.succeed({
          id,
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          avatar: avatarFromBotId("bot-1"),
          createdAt: 1,
          updatedAt: 1,
        } as any),
      findAll: () => Effect.succeed([]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp/bots",
      ensureHome: () => Effect.succeed("/tmp/bots/x"),
      writePersona: () => Effect.void,
      homePath: (id) => `/tmp/bots/${id}`,
      removeHome: () => Effect.void,
    };
    const requests: RunRequest[] = [];
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: true, resumableSessions: true, cancellation: true },
      startRun: (req) => {
        requests.push(req);
        const bot = String(req.botId);
        return Effect.succeed({
          runId: `rt-${requests.length}`,
          sessionId: req.sessionId ?? `sess-${bot}`,
        } as RunHandle);
      },
      cancelRun: () => Effect.void,
      streamEvents: () => Stream.empty,
      getResult: () => Effect.succeed({ exitCode: 0, summary: "done" } as RunResult),
    };
    let runTick = 0;
    const service = new RunService({
      runRepo,
      botRepo,
      workspace,
      runtime,
      clock: { now: () => 100 + runTick++ },
      ids: { generate: () => `run-${++runTick}` },
      conversationSessions: sessions,
    });

    const conv = asConversationId("123e4567-e89b-12d3-a456-426614174001");
    // Bot-1's thread run records its own session.
    await Effect.runPromise(
      service.startRun({
        botId: asBotId("bot-1"),
        prompt: "writer asks",
        conversationId: conv,
      }),
    );
    // Bot-2 (a delegated peer) runs in the same thread via send_message with
    // an explicit conversation id; human-style trigger, no newSession flag.
    await Effect.runPromise(
      service.startRun({
        botId: asBotId("bot-2"),
        prompt: "peer answers",
        conversationId: conv,
      }),
    );
    // Bot-1 runs again in that thread: it must resume ITS session, not the
    // peer's.
    await Effect.runPromise(
      service.startRun({
        botId: asBotId("bot-1"),
        prompt: "writer again",
        conversationId: conv,
      }),
    );

    expect(requests.map((r) => r.sessionId)).toEqual([
      undefined,
      // bot-2 finds no resumable session (fresh run in this thread); it must
      // never resume bot-1's session.
      undefined,
      // bot-1 keeps resuming its own session.
      "sess-bot-1",
    ]);
    // And the stored sessions are attributed per bot.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await Effect.runPromise(sessions.listSessions({ conversationId: conv }));
    expect([...stored].map((s) => `${s.botId ?? null}:${s.runtimeSessionId}`).sort()).toEqual([
      "bot-1:sess-bot-1",
      "bot-2:sess-bot-2",
    ]);
  });

  it("records ask-answer system markers when replying to form input", async () => {
    const store = new Map<string, any>();
    const runRepo: RunRepository = {
      create: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      findById: (id) => Effect.succeed(store.get(id) ?? null),
      findAll: () => Effect.succeed([...store.values()]),
      update: (run) => {
        store.set(run.id, run);
        return Effect.succeed(run);
      },
      appendEvent: () => Effect.void,
      listEvents: () => Effect.succeed([]),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const botRepo: BotRepository = {
      create: (b) => Effect.succeed(b),
      findById: () =>
        Effect.succeed({
          id: "bot-1",
          name: "Bot",
          description: "",
          persona: "",
          status: "active",
          avatar: avatarFromBotId("bot-1"),
          createdAt: 1,
          updatedAt: 1,
        } as any),
      findAll: () => Effect.succeed([]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp/bots",
      ensureHome: () => Effect.succeed("/tmp/bots/x"),
      writePersona: () => Effect.void,
      homePath: (id) => `/tmp/bots/${id}`,
      removeHome: () => Effect.void,
    };
    const form: Form = {
      id: asFormId("frm_1"),
      sessionId: "ses_1",
      title: "Questions",
      fields: [
        {
          type: "string",
          key: "q0",
          description: "Which package manager?",
          options: [
            { value: "bun", label: "bun" },
            { value: "npm", label: "npm" },
          ],
          custom: true,
        },
      ],
    };
    const markers: string[] = [];
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: true, resumableSessions: true, cancellation: true },
      startRun: () => Effect.succeed({ runId: "rt-1", sessionId: "ses_1" } as RunHandle),
      cancelRun: () => Effect.void,
      streamEvents: () => Stream.empty,
      getResult: () =>
        Effect.async<RunResult, RuntimeError>(() => {
          /* hang so the handle stays live */
        }),
      getForm: () => Effect.succeed(form),
      replyToForm: () => Effect.void,
    };
    const service = new RunService({
      runRepo,
      botRepo,
      workspace,
      runtime,
      clock: { now: () => 1000 },
      ids: { generate: () => "run-ask-1" },
      conversationMessages: {
        recordBotReply: () => Effect.void,
        recordSystemMarker: (_conversationId, content) => {
          markers.push(content);
          return Effect.void;
        },
      },
    });

    const conv = asConversationId("123e4567-e89b-12d3-a456-426614174099");
    const run = await Effect.runPromise(
      service.startRun({
        botId: asBotId("bot-1"),
        prompt: "ask me",
        conversationId: conv,
      }),
    );
    await Effect.runPromise(
      runRepo.update({
        ...run,
        status: "awaiting_input",
        pendingFormId: form.id,
        inputDeadlineAt: 1000 + 60_000,
        updatedAt: 1001,
      }),
    );

    await Effect.runPromise(service.replyToInput(asRunId(run.id), { q0: "bun" }));

    expect(markers).toHaveLength(1);
    expect(parseAskAnswerMarker(markers[0]!)).toEqual({
      kind: "ask-answer",
      question: "Which package manager?",
      answer: "bun",
    });
    expect(markers[0]).toBe(encodeAskAnswerMarker("Which package manager?", "bun"));
  });
});
