import { Effect, PubSub, Stream } from "effect";
import type {
  ActivityEvent,
  Conversation,
  ConversationId,
  Message,
  Run,
  RunId,
  Schedule,
  ScheduleId,
  ScheduleOccurrence,
} from "@bebots/domain";
import type {
  ActivityRepository,
  ConversationRepository,
  MessageRepository,
  RunRepository,
  ScheduleRepository,
} from "./repositories.js";

export type LiveEventKind =
  | "activity"
  | "run.event"
  | "run.updated"
  | "conversation.updated"
  | "schedule.updated";

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
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "conversation.updated";
      readonly conversationId: string;
      readonly reason: "created" | "updated" | "deleted" | "message";
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "schedule.updated";
      readonly scheduleId: string;
      readonly botId: string;
      readonly reason: "created" | "updated" | "deleted" | "occurrence";
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
  if (event.kind === "activity") {
    return event.activity.entityType === "run" && event.activity.entityId === runId;
  }
  return false;
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

export function conversationUpdatedLiveEvent(
  conversationId: ConversationId | string,
  reason: "created" | "updated" | "deleted" | "message",
  at: number = Date.now(),
): LiveEvent {
  return {
    v: 1,
    id: newId(),
    at,
    kind: "conversation.updated",
    conversationId: String(conversationId),
    reason,
  };
}

export function scheduleUpdatedLiveEvent(
  scheduleId: ScheduleId | string,
  botId: string,
  reason: "created" | "updated" | "deleted" | "occurrence",
  at: number = Date.now(),
): LiveEvent {
  return {
    v: 1,
    id: newId(),
    at,
    kind: "schedule.updated",
    scheduleId: String(scheduleId),
    botId,
    reason,
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

/** Publish conversation list changes for the desktop SSE subscriber. */
export function withLiveConversationPublishing(
  repo: ConversationRepository,
  bus: LiveEventBus,
): ConversationRepository {
  return {
    create: (conversation) =>
      repo.create(conversation).pipe(
        Effect.tap((created: Conversation) =>
          Effect.sync(() => bus.publish(conversationUpdatedLiveEvent(created.id, "created"))),
        ),
      ),
    findById: (id) => repo.findById(id),
    findAll: (options) => repo.findAll(options),
    update: (conversation) =>
      repo.update(conversation).pipe(
        Effect.tap((updated: Conversation) =>
          Effect.sync(() => bus.publish(conversationUpdatedLiveEvent(updated.id, "updated"))),
        ),
      ),
    delete: (id) =>
      repo.delete(id).pipe(
        Effect.tap(() =>
          Effect.sync(() => bus.publish(conversationUpdatedLiveEvent(id, "deleted"))),
        ),
      ),
  };
}

/** Publish message creates so open threads refresh without polling. */
export function withLiveMessagePublishing(
  repo: MessageRepository,
  bus: LiveEventBus,
): MessageRepository {
  return {
    create: (message) =>
      repo.create(message).pipe(
        Effect.tap((created: Message) =>
          Effect.sync(() =>
            bus.publish(conversationUpdatedLiveEvent(created.conversationId, "message")),
          ),
        ),
      ),
    findById: (id) => repo.findById(id),
    findByConversation: (conversationId, options) =>
      repo.findByConversation(conversationId, options),
    findAll: (options) => repo.findAll(options),
    update: (message) => repo.update(message),
    delete: (id) => repo.delete(id),
    deleteByConversation: (conversationId) => repo.deleteByConversation(conversationId),
  };
}

/** Publish schedule and occurrence changes for the schedules panel. */
export function withLiveSchedulePublishing(
  repo: ScheduleRepository,
  bus: LiveEventBus,
): ScheduleRepository {
  const publishSchedule = (
    scheduleId: ScheduleId | string,
    botId: string,
    reason: "created" | "updated" | "deleted" | "occurrence",
  ) => Effect.sync(() => bus.publish(scheduleUpdatedLiveEvent(scheduleId, botId, reason)));

  return {
    create: (schedule) =>
      repo
        .create(schedule)
        .pipe(
          Effect.tap((created: Schedule) =>
            publishSchedule(created.id, String(created.botId), "created"),
          ),
        ),
    findById: (id) => repo.findById(id),
    findAll: (options) => repo.findAll(options),
    findDue: (now) => repo.findDue(now),
    update: (schedule) =>
      repo
        .update(schedule)
        .pipe(
          Effect.tap((updated: Schedule) =>
            publishSchedule(updated.id, String(updated.botId), "updated"),
          ),
        ),
    delete: (id) =>
      Effect.gen(function* () {
        const existing = yield* repo.findById(id);
        yield* repo.delete(id);
        if (existing) {
          yield* publishSchedule(id, String(existing.botId), "deleted");
        }
      }),
    createOccurrence: (occurrence) =>
      repo.createOccurrence(occurrence).pipe(
        Effect.tap((created: ScheduleOccurrence) =>
          Effect.gen(function* () {
            const schedule = yield* repo.findById(created.scheduleId);
            if (schedule) {
              yield* publishSchedule(schedule.id, String(schedule.botId), "occurrence");
            }
          }),
        ),
      ),
    findOccurrence: (id) => repo.findOccurrence(id),
    findOccurrenceByRun: (runId) => repo.findOccurrenceByRun(runId),
    listOccurrences: (scheduleId, options) => repo.listOccurrences(scheduleId, options),
    findOccurrences: (options) => repo.findOccurrences(options),
    updateOccurrence: (occurrence) =>
      repo.updateOccurrence(occurrence).pipe(
        Effect.tap((updated: ScheduleOccurrence) =>
          Effect.gen(function* () {
            const schedule = yield* repo.findById(updated.scheduleId);
            if (schedule) {
              yield* publishSchedule(schedule.id, String(schedule.botId), "occurrence");
            }
          }),
        ),
      ),
    deleteOccurrences: (scheduleId) => repo.deleteOccurrences(scheduleId),
  };
}
