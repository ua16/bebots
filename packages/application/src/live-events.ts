import { Effect, PubSub, Stream } from "effect";
import type { ActivityEvent, Run, RunId } from "@bebots/domain";
import type { ActivityRepository, RunRepository } from "./repositories.js";

export type LiveEventKind = "activity" | "run.event" | "run.updated";

export type LiveEvent =
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "activity";
      readonly activity: {
        readonly id: string;
        readonly type: string;
        readonly entityType: string;
        readonly entityId: string;
        readonly actorId: string | null;
        readonly payload?: unknown;
        readonly createdAt: number;
      };
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "run.event";
      readonly runId: string;
      readonly event: unknown;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "run.updated";
      readonly run: unknown;
    };

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function newId(): string {
  return crypto.randomUUID();
}

/** In-process hub for live API SSE subscribers. */
export class LiveEventBus {
  private readonly pubsub: PubSub.PubSub<LiveEvent>;

  constructor(pubsub?: PubSub.PubSub<LiveEvent>) {
    this.pubsub = pubsub ?? Effect.runSync(PubSub.sliding<LiveEvent>(512));
  }

  publish(event: LiveEvent): void {
    PubSub.publishUnsafe(this.pubsub, event);
  }

  stream(options?: { readonly runId?: string }): Stream.Stream<LiveEvent> {
    const runId = options?.runId;
    const source = Stream.fromPubSub(this.pubsub);
    if (!runId) return source;
    return Stream.filter(source, (event) => matchesRunId(event, runId));
  }
}

export function matchesRunId(event: LiveEvent, runId: string): boolean {
  if (event.kind === "run.event") return event.runId === runId;
  if (event.kind === "run.updated") {
    const run = event.run as { readonly id?: unknown } | null;
    return run !== null && typeof run === "object" && run.id === runId;
  }
  return event.activity.entityType === "run" && event.activity.entityId === runId;
}

export function activityLiveEvent(activity: ActivityEvent, at: number = Date.now()): LiveEvent {
  return {
    v: 1,
    id: newId(),
    at,
    kind: "activity",
    activity: {
      id: String(activity.id),
      type: activity.type,
      entityType: activity.entityType,
      entityId: activity.entityId,
      actorId: activity.actorId ?? null,
      ...(activity.payload !== undefined && { payload: jsonClone(activity.payload) }),
      createdAt: activity.createdAt,
    },
  };
}

export function runEventLiveEvent(
  runId: RunId | string,
  event: unknown,
  at: number = Date.now(),
): LiveEvent {
  return {
    v: 1,
    id: newId(),
    at,
    kind: "run.event",
    runId: String(runId),
    event: jsonClone(event),
  };
}

export function runUpdatedLiveEvent(run: Run, at: number = Date.now()): LiveEvent {
  return {
    v: 1,
    id: newId(),
    at,
    kind: "run.updated",
    run: jsonClone(run),
  };
}

/** Publish activity creates without changing callers of ActivityRepository. */
export function withLiveActivityPublishing(
  repo: ActivityRepository,
  bus: LiveEventBus,
): ActivityRepository {
  return {
    create: (event) =>
      repo.create(event).pipe(
        Effect.tap((created) => Effect.sync(() => bus.publish(activityLiveEvent(created)))),
      ),
    findAll: (options) => repo.findAll(options),
    deleteByEntityIds: (entityType, entityIds) => repo.deleteByEntityIds(entityType, entityIds),
  };
}

/** Publish run events and row updates without changing RunRepository callers. */
export function withLiveRunPublishing(repo: RunRepository, bus: LiveEventBus): RunRepository {
  return {
    create: (run) =>
      repo.create(run).pipe(
        Effect.tap((created) => Effect.sync(() => bus.publish(runUpdatedLiveEvent(created)))),
      ),
    findById: (id) => repo.findById(id),
    findAll: (options) => repo.findAll(options),
    update: (run) =>
      repo.update(run).pipe(
        Effect.tap((updated) => Effect.sync(() => bus.publish(runUpdatedLiveEvent(updated)))),
      ),
    appendEvent: (runId, event) =>
      repo.appendEvent(runId, event).pipe(
        Effect.tap(() => Effect.sync(() => bus.publish(runEventLiveEvent(runId, event)))),
      ),
    listEvents: (runId) => repo.listEvents(runId),
    deleteByBot: (botId) => repo.deleteByBot(botId),
    deleteByConversation: (conversationId) => repo.deleteByConversation(conversationId),
  };
}
