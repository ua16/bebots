import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { asBotId } from "@bebots/domain";
import { TaskService } from "./task-service.js";
import type { TaskRepository } from "./repositories.js";
import type { BotRepository, BotWorkspace, Clock, IdGenerator, RunRepository } from "./repositories.js";
import { RunService } from "./run-service.js";
import type { AgentRuntime, RunHandle, RunRequest, RunResult, RuntimeError, RuntimeEvent } from "./runtime.js";
import { Stream } from "effect";

function makeTaskRepo(): TaskRepository {
  const store = new Map<string, any>();
  return {
    create: (t: any) => { store.set(t.id, t); return Effect.succeed(t); },
    findById: (id: any) => Effect.succeed(store.get(String(id)) ?? null),
    findAll: (opts: any) => Effect.succeed([...store.values()].filter((t:any) => (!opts?.assignee || t.assignee===opts.assignee) && (!opts?.status || t.status===opts.status))),
    update: (t: any) => { store.set(t.id, t); return Effect.succeed(t); },
    delete: (id: any) => { store.delete(String(id)); return Effect.void; },
    findByIdempotencyKey: (key: any) => Effect.succeed([...store.values()].find((t:any)=>t.idempotencyKey===key) ?? null),
  } as any;
}

function makeBotRepo() {
  return {
    create: (b:any)=>Effect.succeed(b),
    findById: (id:any)=>Effect.succeed({ id, name:"Bot", description:"", persona:"", status:"active", createdAt:1, updatedAt:1 } as any),
    findAll: ()=>Effect.succeed([]),
    update: (b:any)=>Effect.succeed(b),
    delete: ()=>Effect.void,
  } as any;
}

function makeRunRepo() {
  const store = new Map<string, any>();
  return {
    create: (r:any)=>{store.set(r.id,r);return Effect.succeed(r);},
    findById: (id:any)=>Effect.succeed(store.get(String(id)) ?? null),
    findAll: (opts:any)=>Effect.succeed([...store.values()].filter((r:any)=>(!opts?.botId||r.botId===opts.botId)&&(!opts?.status||r.status===opts.status))),
    update: (r:any)=>{store.set(r.id,r);return Effect.succeed(r);},
    appendEvent: ()=>Effect.void,
    listEvents: ()=>Effect.succeed([]),
  } as any;
}

describe("TaskService smoke", () => {
  it("delegates and completes", async () => {
    const taskRepo = makeTaskRepo();
    const botRepo = makeBotRepo();
    const runRepo = makeRunRepo();
    const runtime: AgentRuntime = {
      id: "fake", capabilities: { streaming: true, resumableSessions: false, cancellation: true },
      startRun: (_req: RunRequest) => Effect.succeed({ runId: "rt-1", sessionId: "s" } as RunHandle),
      cancelRun: () => Effect.void,
      streamEvents: () => Stream.fromIterable([{ _tag: "completed", summary: "done" }] as RuntimeEvent[]),
      getResult: () => Effect.succeed({ exitCode: 0, summary: "done" } as RunResult),
    };
    const workspace: BotWorkspace = { root: "/tmp", ensureHome: ()=>Effect.succeed("/tmp"), writePersona:()=>Effect.void, homePath:()=>"/tmp" };
    const runService = new RunService(runRepo, botRepo, workspace, runtime, { now:()=>1 }, { generate:()=> "run-1" });
    const taskService = new TaskService({ taskRepo, botRepo, runService, clock: { now:()=>1 }, ids: { generate:()=> "task-1" } });
    runService.setTaskResults(taskService);
    const task = await Effect.runPromise(taskService.delegate({ requester: "human", assignee: "bot-1", description: "do thing" }));
    expect(task.status).toBe("running");
    // wait for run finalization
    await new Promise((r)=>setTimeout(r,50));
    const updated = await Effect.runPromise(taskService.getTask(String(task.id)));
    expect(updated?.status).toBe("succeeded");
    expect(updated?.resultSummary).toBe("done");
  });
});
