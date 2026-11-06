import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { TaskService } from "./task-service.js";
import type { TaskRepository, BotRepository, RunRepository, BotWorkspace } from "./repositories.js";
import { RunService } from "./run-service.js";
import type { AgentRuntime, RunHandle, RunRequest, RunResult, RuntimeEvent } from "./runtime.js";
import { Stream } from "effect";
import type { Bot, BotId, Run, Task } from "@bebots/domain";

function makeTaskRepo(): TaskRepository {
  const store = new Map<string, Task>();
  return {
    create: (task) => {
      store.set(String(task.id), task);
      return Effect.succeed(task);
    },
    findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
    findAll: (opts) =>
      Effect.succeed(
        [...store.values()].filter(
          (task) =>
            (!opts?.assignee || task.assignee === opts.assignee) &&
            (!opts?.status || task.status === opts.status),
        ),
      ),
    update: (task) => {
      store.set(String(task.id), task);
      return Effect.succeed(task);
    },
    delete: (id) => {
      store.delete(String(id));
      return Effect.void;
    },
    findByIdempotencyKey: (key) =>
      Effect.succeed([...store.values()].find((task) => task.idempotencyKey === key) ?? null),
  };
}

function makeBotRepo(): BotRepository {
  const fakeBot = (id: BotId): Bot => ({
    id,
    name: "Bot",
    description: "",
    persona: "",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  return {
    create: (bot) => Effect.succeed(bot),
    findById: (id) => Effect.succeed(fakeBot(id)),
    findAll: () => Effect.succeed([]),
    update: (bot) => Effect.succeed(bot),
    delete: () => Effect.void,
  };
}

function makeRunRepo(): RunRepository {
  const store = new Map<string, Run>();
  return {
    create: (run) => {
      store.set(String(run.id), run);
      return Effect.succeed(run);
    },
    findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
    findAll: (opts) =>
      Effect.succeed(
        [...store.values()].filter(
          (run) =>
            (!opts?.botId || run.botId === opts.botId) &&
            (!opts?.status || run.status === opts.status),
        ),
      ),
    update: (run) => {
      store.set(String(run.id), run);
      return Effect.succeed(run);
    },
    appendEvent: () => Effect.void,
    listEvents: () => Effect.succeed([]),
  };
}

describe("TaskService smoke", () => {
  it("delegates and completes", async () => {
    const taskRepo = makeTaskRepo();
    const botRepo = makeBotRepo();
    const runRepo = makeRunRepo();
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { streaming: true, resumableSessions: false, cancellation: true },
      startRun: (_req: RunRequest) =>
        Effect.succeed({ runId: "rt-1", sessionId: "s" } as RunHandle),
      cancelRun: () => Effect.void,
      streamEvents: () =>
        Stream.fromIterable([{ _tag: "completed", summary: "done" }] as RuntimeEvent[]),
      getResult: () => Effect.succeed({ exitCode: 0, summary: "done" } as RunResult),
    };
    const workspace: BotWorkspace = {
      root: "/tmp",
      ensureHome: () => Effect.succeed("/tmp"),
      writePersona: () => Effect.void,
      homePath: () => "/tmp",
    };
    const runService = new RunService({
      runRepo,
      botRepo,
      workspace,
      runtime,
      clock: { now: () => 1 },
      ids: { generate: () => "run-1" },
    });
    const taskService = new TaskService({
      taskRepo,
      botRepo,
      runService,
      clock: { now: () => 1 },
      ids: { generate: () => "task-1" },
    });
    runService.setTaskResults(taskService);
    const task = await Effect.runPromise(
      taskService.delegate({ requester: "human", assignee: "bot-1", description: "do thing" }),
    );
    expect(task.status).toBe("running");
    // wait for run finalization
    await new Promise((r) => setTimeout(r, 50));
    const updated = await Effect.runPromise(taskService.getTask(String(task.id)));
    expect(updated?.status).toBe("succeeded");
    expect(updated?.resultSummary).toBe("done");
  });
});
