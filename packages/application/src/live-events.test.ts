import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { asActivityId, asBotId, asRunId } from "@bebots/domain";
import type { ActivityEvent, Run } from "@bebots/domain";
import {
  LiveEventBus,
  activityLiveEvent,
  matchesRunId,
  runEventLiveEvent,
  runUpdatedLiveEvent,
  withLiveActivityPublishing,
  withLiveRunPublishing,
} from "./live-events.js";
import type { ActivityRepository, RunRepository } from "./repositories.js";
import { RepositoryError } from "./errors.js";

async function collectNext(
  bus: LiveEventBus,
  count: number,
  publish: () => void | Promise<void>,
  options?: { readonly runId?: string },
) {
  const fiber = Effect.runFork(Stream.runCollect(Stream.take(bus.stream(options), count)));
  await Effect.runPromise(Effect.yieldNow);
  await publish();
  return Effect.runPromise(Fiber.join(fiber));
}

describe("LiveEventBus", () => {
  it("delivers published events to subscribers", async () => {
    const bus = new LiveEventBus();
    const event = activityLiveEvent({
      id: asActivityId("a1"),
      type: "test",
      entityType: "bot",
      entityId: "b1",
      actorId: null,
      createdAt: 1,
    });
    const events = await collectNext(bus, 1, () => bus.publish(event));
    expect(events).toEqual([event]);
  });

  it("filters by runId", () => {
    const activity = activityLiveEvent({
      id: asActivityId("a1"),
      type: "x",
      entityType: "run",
      entityId: "r1",
      actorId: null,
      createdAt: 1,
    });
    const otherActivity = activityLiveEvent({
      id: asActivityId("a2"),
      type: "x",
      entityType: "run",
      entityId: "r2",
      actorId: null,
      createdAt: 1,
    });
    const runEvent = runEventLiveEvent("r1", { _tag: "started" });
    const runUpdated = runUpdatedLiveEvent({
      id: asRunId("r1"),
      botId: asBotId("b1"),
      triggerType: "manual",
      prompt: "p",
      status: "running",
      timeoutMs: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(matchesRunId(activity, "r1")).toBe(true);
    expect(matchesRunId(otherActivity, "r1")).toBe(false);
    expect(matchesRunId(runEvent, "r1")).toBe(true);
    expect(matchesRunId(runUpdated, "r1")).toBe(true);
  });
});

describe("publishing repository wrappers", () => {
  it("publishes activity creates", async () => {
    const bus = new LiveEventBus();
    const created: ActivityEvent = {
      id: asActivityId("a1"),
      type: "bot.created",
      entityType: "bot",
      entityId: "b1",
      actorId: null,
      createdAt: 42,
    };
    const base: ActivityRepository = {
      create: () => Effect.succeed(created),
      findAll: () => Effect.succeed([]),
      deleteByEntityIds: () => Effect.succeed(0),
    };
    const repo = withLiveActivityPublishing(base, bus);
    const events = await collectNext(bus, 1, () => Effect.runPromise(repo.create(created)));
    expect(events[0]?.kind).toBe("activity");
    if (events[0]?.kind === "activity") {
      expect(events[0].activity.id).toBe("a1");
    }
  });

  it("publishes run appendEvent and update", async () => {
    const bus = new LiveEventBus();
    const run: Run = {
      id: asRunId("r1"),
      botId: asBotId("b1"),
      triggerType: "api",
      prompt: "go",
      status: "running",
      timeoutMs: 1000,
      createdAt: 1,
      updatedAt: 2,
    };
    const base: RunRepository = {
      create: (r) => Effect.succeed(r),
      findById: () => Effect.succeed(null),
      findAll: () => Effect.succeed([]),
      update: (r) => Effect.succeed(r),
      appendEvent: () => Effect.void,
      listEvents: () => Effect.succeed([]),
      deleteByBot: () => Effect.succeed(0),
      deleteByConversation: () => Effect.succeed(0),
    };
    const repo = withLiveRunPublishing(base, bus);
    const events = await collectNext(bus, 2, async () => {
      await Effect.runPromise(repo.appendEvent(asRunId("r1"), { _tag: "progress", message: "hi" }));
      await Effect.runPromise(repo.update(run));
    });
    expect(events.map((e) => e.kind)).toEqual(["run.event", "run.updated"]);
  });

  it("still surfaces repository failures", async () => {
    const bus = new LiveEventBus();
    const base: ActivityRepository = {
      create: () => Effect.fail(new RepositoryError("nope")),
      findAll: () => Effect.succeed([]),
      deleteByEntityIds: () => Effect.succeed(0),
    };
    const repo = withLiveActivityPublishing(base, bus);
    await expect(Effect.runPromise(repo.create({} as ActivityEvent))).rejects.toBeTruthy();
  });
});
