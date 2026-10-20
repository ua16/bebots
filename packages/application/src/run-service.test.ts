/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { asBotId, asRunId } from "@bebots/domain";
import { RunService, RunSupervisor } from "./run-service.js";
import type {
  BotRepository,
  BotWorkspace,
  Clock,
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
    const service = new RunService(runRepo, botRepo, workspace, runtime, clock, ids);

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
    };
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: false, resumableSessions: false, cancellation: false },
      startRun: () => Effect.succeed({ runId: "r" } as RunHandle),
      cancelRun: () => Effect.void,
      streamEvents: () => Stream.empty as any,
      getResult: () => Effect.succeed({ exitCode: 0, summary: "" } as RunResult),
    };
    const service = new RunService(
      runRepo,
      botRepo,
      workspace,
      runtime,
      { now: () => 1 },
      { generate: () => "r1" },
    );
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
    const service = new RunService(
      runRepo,
      botRepo,
      workspace,
      runtime2,
      { now: () => 1 },
      { generate: () => "run-1" },
    );
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
    const service = new RunService(
      runRepo,
      botRepo,
      workspace,
      runtime,
      { now: () => 1 },
      { generate: () => "run-1" },
    );
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
  it("accepts a deps object using the alternative key names", async () => {
    const { repo } = makeRunRepo();
    const service = new RunService({
      runRepository: repo,
      botRepository: makeBotRepo(),
      workspace: makeWorkspace(),
      runtime: makeRuntime(),
      clock: { now: () => 5 },
      idGenerator: { generate: () => "run-x" },
    } as never);

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    expect(run.id).toBe("run-x");
    expect(run.status).toBe("running");
  });

  it("rejects an invalid generated run id", async () => {
    const service = new RunService(
      makeRunRepo().repo,
      makeBotRepo(),
      makeWorkspace(),
      makeRuntime(),
      { now: () => 1 },
      { generate: () => "   " },
    );
    await expect(
      Effect.runPromise(service.startRun({ botId: asBotId("bot-1"), prompt: "hi" })),
    ).rejects.toThrow();
  });

  it("marks the run failed when the runtime cannot produce a result", async () => {
    const { repo } = makeRunRepo();
    const runtime = makeRuntime({
      getResult: () => Effect.fail({ _tag: "RuntimeError", message: "nope" } as RuntimeError),
    });
    const service = new RunService(
      repo,
      makeBotRepo(),
      makeWorkspace(),
      runtime,
      { now: () => 1 },
      { generate: () => "run-fail" },
    );

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
    const service = new RunService(
      repo,
      makeBotRepo(),
      makeWorkspace(),
      runtime,
      { now: () => 1 },
      { generate: () => "run-wait" },
    );

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    const waited = await Effect.runPromise(service.awaitRun(run.id, 10));
    expect(waited?.status).toBe("running");
  });

  it("cancels a run without an active handle and returns null for unknown runs", async () => {
    const { repo, store } = makeRunRepo();
    const service = new RunService(
      repo,
      makeBotRepo(),
      makeWorkspace(),
      makeRuntime(),
      { now: () => 1 },
      { generate: () => "run-c" },
    );
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

  it("RunSupervisor is a RunService", () => {
    const supervisor = new RunSupervisor(
      makeRunRepo().repo,
      makeBotRepo(),
      makeWorkspace(),
      makeRuntime(),
      { now: () => 1 },
      { generate: () => "run-s" },
    );
    expect(supervisor).toBeInstanceOf(RunService);
  });

  it("treats a non-object first argument as a positional repository", () => {
    const service = new RunService(
      null as never,
      makeBotRepo(),
      makeWorkspace(),
      makeRuntime(),
      { now: () => 1 },
      { generate: () => "run-null" },
    );
    expect(service).toBeInstanceOf(RunService);
  });

  it("rejects a missing prompt and falls back when a session id is omitted", async () => {
    const { repo } = makeRunRepo();
    const runtime = makeRuntime({
      startRun: () => Effect.succeed({ runId: "rt-1" } as RunHandle),
    });
    const service = new RunService(
      repo,
      makeBotRepo(),
      makeWorkspace(),
      runtime,
      { now: () => 1 },
      { generate: () => "run-ns" },
    );

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
    const service = new RunService(
      repo,
      makeBotRepo(),
      makeWorkspace(),
      runtime,
      { now: () => 1 },
      { generate: () => "run-stream" },
    );

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
    const service = new RunService(
      repo,
      makeBotRepo(),
      makeWorkspace(),
      runtime,
      { now: () => 1 },
      { generate: () => "run-err" },
    );

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
    const service = new RunService(
      repo,
      makeBotRepo(),
      makeWorkspace(),
      runtime,
      { now: () => 1 },
      { generate: () => "run-1" },
    );

    const run = await Effect.runPromise(
      service.startRun({ botId: asBotId("bot-1"), prompt: "hi" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBeGreaterThanOrEqual(2);
    // The cancelled guard short-circuits, so the run is left untouched.
    expect(base.store.get(run.id)?.status).toBe("running");
  });
});
