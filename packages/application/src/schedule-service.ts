import { Effect, Option, Schema } from "effect";
/* eslint-disable @typescript-eslint/no-this-alias */
import {
  asActivityId,
  asBotId,
  asRunId,
  asScheduleId,
  asScheduleOccurrenceId,
  nextScheduleFire,
  ScheduleTriggerSchema,
} from "@bebots/domain";
import type {
  Conversation,
  ConversationId,
  Message,
  Schedule,
  ScheduleId,
  ScheduleOccurrence,
  ScheduleTrigger,
} from "@bebots/domain";
import type {
  ActivityRepository,
  BotRepository,
  Clock,
  IdGenerator,
  ScheduleRepository,
} from "./repositories.js";
import type { AddMessageInput, CreateConversationInput } from "./conversation-service.js";
import type { RunService, ScheduleResultRecorder } from "./run-service.js";
import { NotFoundError, RepositoryError, ServiceError, ValidationError } from "./errors.js";

/** Occurrences older than this are skipped as missed, not back-filled (PLAN §9). */
export const MISSED_RUN_HISTORY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** At most this many catch-up occurrences of one schedule fire per tick. */
export const MAX_CATCH_UP_OCCURRENCES = 5;
/** An occurrence stops retrying enqueueing after this many failed attempts. */
export const MAX_ENQUEUE_ATTEMPTS = 10;
/** Per-creator cap on stored schedules; prevents runaway MCP loops. */
export const MAX_SCHEDULES_PER_CREATOR = 50;

/** The user side of a scheduled-run thread: participants are [botId, "human"]. */
export const HUMAN_PARTICIPANT = "human";

/**
 * Conversation provisioning for scheduled runs (a scheduled run is treated as
 * a conversation between the bot and the user). Satisfied structurally by
 * `ConversationService`.
 */
export interface ScheduleConversationStore {
  readonly getConversation: (id: string) => Effect.Effect<Conversation | null, RepositoryError>;
  readonly createConversation: (
    input?: CreateConversationInput,
  ) => Effect.Effect<Conversation, ValidationError | RepositoryError>;
  readonly addMessage: (
    input: AddMessageInput,
  ) => Effect.Effect<Message, ValidationError | RepositoryError>;
}

export interface CreateScheduleInput {
  readonly botId: string;
  readonly prompt: string;
  /** Untrusted trigger definition; validated against the domain rules. */
  readonly trigger: unknown;
  readonly enabled?: boolean;
  readonly conversationId?: string | null;
  /** Creator identity (bot id via MCP) or absent/`null` for user-created. */
  readonly createdBy?: string | null;
}

export interface UpdateScheduleInput {
  readonly prompt?: string;
  readonly trigger?: unknown;
  readonly enabled?: boolean;
}

export interface ScheduleTickSummary {
  readonly enqueued: number;
  readonly missed: number;
  readonly failed: number;
}

export interface ScheduleServiceDeps {
  readonly scheduleRepo: ScheduleRepository;
  readonly botRepo: BotRepository;
  /** Enqueues the run for a due occurrence; a scheduled run is trigger type "schedule". */
  readonly runService: RunService;
  readonly activity?: ActivityRepository;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /**
   * Conversation provisioning for scheduled runs: a fired schedule becomes a
   * conversation between that bot and the user (its own dedicated thread),
   * the bot's result is posted there as a reply, and the user can respond.
   * When absent, runs fire threadless (legacy behavior).
   */
  readonly threads?: ScheduleConversationStore;
  /** Debug log (enabled via `--show-scheduling-logs`) when a schedule is created and when it runs. */
  readonly showSchedulingLogs?: boolean;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

/** Compact one-line description of a schedule trigger for the debug log. */
function describeTrigger(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case "once":
      return `once@${new Date(trigger.at).toISOString()}`;
    case "interval":
      return `interval:${trigger.everyMs}ms`;
    case "cron":
      return `cron:"${trigger.expression}" (${trigger.timezone})`;
  }
}

/** Sidebar title for a schedule's dedicated thread with the user. */
export function scheduleThreadTitle(prompt: string): string {
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  const short = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  return `Scheduled: ${short}`;
}

/** User-facing one-line description of a trigger (thread marker text). */
export function scheduledRunTriggerDescription(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case "interval": {
      const minutes = trigger.everyMs / 60_000;
      if (minutes >= 60 && minutes % 60 === 0) return `every ${minutes / 60}h`;
      return Number.isInteger(minutes)
        ? `every ${minutes}m`
        : `every ${Math.round(trigger.everyMs / 1000)}s`;
    }
    case "once":
      return `once at ${new Date(trigger.at).toLocaleString()}`;
    case "cron":
      return `cron ${trigger.expression} (${trigger.timezone})`;
  }
}

export class ScheduleService implements ScheduleResultRecorder {
  private readonly scheduleRepo: ScheduleRepository;
  private readonly botRepo: BotRepository;
  private readonly runService: RunService;
  private readonly activity: ActivityRepository | undefined;
  private readonly threads: ScheduleConversationStore | undefined;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly showSchedulingLogs: boolean;
  private ticking = false;

  constructor(deps: ScheduleServiceDeps) {
    this.scheduleRepo = deps.scheduleRepo;
    this.botRepo = deps.botRepo;
    this.runService = deps.runService;
    this.activity = deps.activity;
    this.threads = deps.threads;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.ids = deps.ids ?? { generate: () => crypto.randomUUID() };
    this.showSchedulingLogs = deps.showSchedulingLogs ?? false;
  }

  // -- CRUD ---------------------------------------------------------------

  createSchedule(
    input: CreateScheduleInput,
  ): Effect.Effect<Schedule, ValidationError | NotFoundError | RepositoryError | ServiceError> {
    const scheduleRepo = this.scheduleRepo;
    const botRepo = this.botRepo;
    const clock = this.clock;
    const ids = this.ids;
    const showSchedulingLogs = this.showSchedulingLogs;
    return Effect.gen(function* () {
      const prompt = (input.prompt ?? "").trim();
      if (prompt.length === 0) {
        return yield* Effect.fail(new ValidationError("prompt", "Schedule prompt cannot be empty"));
      }
      const bot = yield* botRepo.findById(asBotId(input.botId));
      if (!bot) {
        return yield* Effect.fail(new NotFoundError("Bot", input.botId));
      }
      let trigger: ScheduleTrigger;
      try {
        trigger = Schema.decodeUnknownSync(ScheduleTriggerSchema)(input.trigger);
      } catch (e) {
        return yield* Effect.fail(new ValidationError("trigger", (e as { message?: string }).message ?? "Invalid trigger"));
      }
      // A `once` trigger in the past can never fire — reject rather than lie.
      if (trigger.kind === "once" && trigger.at <= clock.now()) {
        return yield* Effect.fail(
          new ValidationError("trigger", "Trigger at must be in the future"),
        );
      }
      // Bounded schedules per creator so bots cannot loop schedule creation.
      const createdBy = input.createdBy ?? null;
      if (createdBy) {
        const existing = yield* scheduleRepo.findAll({
          createdBy,
          limit: MAX_SCHEDULES_PER_CREATOR + 1,
        });
        if (existing.length >= MAX_SCHEDULES_PER_CREATOR) {
          return yield* Effect.fail(new ServiceError("Schedule limit reached for this bot"));
        }
      }
      let id: ScheduleId;
      try {
        id = asScheduleId(ids.generate());
      } catch {
        return yield* Effect.fail(new ValidationError("id", "Invalid schedule id"));
      }
      const now = clock.now();
      const anchor = now;
      const enabled = input.enabled ?? true;
      const schedule = {
        id,
        botId: asBotId(input.botId),
        prompt,
        trigger,
        enabled,
        conversationId: input.conversationId ?? null,
        createdBy,
        anchorAt: anchor,
        nextRunAt: enabled ? nextScheduleFire(trigger, now, anchor) : null,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      } as unknown as Schedule;
      const created = yield* scheduleRepo.create(schedule);
      if (showSchedulingLogs) {
        console.log(
          `[schedule] added: ${String(schedule.id)} bot=${String(schedule.botId)} trigger=${describeTrigger(schedule.trigger)} prompt="${schedule.prompt}"`,
        );
      }
      return created;
    }) as Effect.Effect<Schedule, ValidationError | NotFoundError | RepositoryError | ServiceError>;
  }

  updateSchedule(
    id: string,
    patch: UpdateScheduleInput,
  ): Effect.Effect<Schedule, NotFoundError | ValidationError | RepositoryError | ServiceError> {
    const scheduleRepo = this.scheduleRepo;
    const clock = this.clock;
    return Effect.gen(function* () {
      const schedule = yield* scheduleRepo.findById(asScheduleId(id));
      if (!schedule) {
        return yield* Effect.fail(new NotFoundError("Schedule", id));
      }
      let trigger: ScheduleTrigger = schedule.trigger;
      if (patch.trigger !== undefined) {
        let decoded: ScheduleTrigger;
        try {
          decoded = Schema.decodeUnknownSync(ScheduleTriggerSchema)(patch.trigger);
        } catch (e) {
          return yield* Effect.fail(new ValidationError("trigger", (e as { message?: string }).message ?? "Invalid trigger"));
        }
        trigger = decoded;
        if (trigger.kind === "once" && trigger.at <= clock.now()) {
          return yield* Effect.fail(
            new ValidationError("trigger", "Trigger at must be in the future"),
          );
        }
      }
      const enabled = patch.enabled ?? schedule.enabled;
      const now = clock.now();
      // Recomputing on enablement/trigger change keeps nextRunAt in the future
      // (and route through the missed-run policy on the next tick).
      const nextRunAt = enabled ? nextScheduleFire(trigger, now, schedule.anchorAt) : null;
      return yield* scheduleRepo.update({
        ...schedule,
        prompt: patch.prompt !== undefined ? patch.prompt : schedule.prompt,
        trigger,
        enabled,
        nextRunAt,
        updatedAt: now,
      } as Schedule);
    }) as Effect.Effect<Schedule, NotFoundError | ValidationError | RepositoryError | ServiceError>;
  }

  getSchedule(id: string): Effect.Effect<Schedule | null, RepositoryError> {
    return this.scheduleRepo.findById(asScheduleId(id));
  }

  listSchedules(options?: {
    readonly botId?: string;
    readonly createdBy?: string;
    readonly limit?: number;
  }): Effect.Effect<readonly Schedule[], RepositoryError> {
    return this.scheduleRepo.findAll({
      ...(options?.botId !== undefined ? { botId: asBotId(options.botId) } : {}),
      ...(options?.createdBy !== undefined ? { createdBy: options.createdBy } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  deleteSchedule(id: string): Effect.Effect<void, NotFoundError | RepositoryError> {
    const scheduleRepo = this.scheduleRepo;
    return Effect.gen(function* () {
      yield* scheduleRepo.deleteOccurrences(asScheduleId(id));
      return yield* scheduleRepo.delete(asScheduleId(id));
    }) as Effect.Effect<void, NotFoundError | RepositoryError>;
  }

  /** Occurrence history for a schedule (PLAN §9: schedule history). */
  listHistory(
    id: string,
    limit?: number,
  ): Effect.Effect<readonly ScheduleOccurrence[], RepositoryError> {
    return this.scheduleRepo.listOccurrences(
      asScheduleId(id),
      limit !== undefined ? { limit } : undefined,
    );
  }

  // -- Scheduler core -----------------------------------------------------

  /**
   * One scheduler tick: retry pending occurrences, process due schedules
   * (catch-up occurrences, missed-run policy), and advance nextRunAt.
   */
  tick(): Effect.Effect<ScheduleTickSummary, unknown> {
    const self = this;
    return Effect.gen(function* () {
      if (self.ticking) {
        return { enqueued: 0, missed: 0, failed: 0 };
      }
      self.ticking = true;
      const summary: { enqueued: number; missed: number; failed: number } = {
        enqueued: 0,
        missed: 0,
        failed: 0,
      };
      try {
        yield* self.recoverStaleOccurrences({
          onEnqueued: () => summary.enqueued++,
          onFailed: () => summary.failed++,
        });
        yield* self.processDueSchedules(summary);
      } finally {
        self.ticking = false;
      }
      return summary;
    });
  }

  private recoverStaleOccurrences(counters?: {
    onEnqueued: () => void;
    onFailed: () => void;
  }): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.gen(function* () {
      // `enqueued` occurrences whose run is gone/terminal after a restart get
      // resolved here (PLAN: recover safely from app restarts).
      const enqueued = yield* self.scheduleRepo.findOccurrences({ status: "enqueued" });
      for (const occurrence of enqueued) {
        if (!occurrence.runId) continue;
        const run = yield* Effect.option(self.runService.getRun(occurrence.runId));
        if (Option.isNone(run) || run.value === null) {
          // The run record vanished; requeue the occurrence for enqueueing.
          yield* self.scheduleRepo.updateOccurrence({
            ...occurrence,
            status: "pending",
            runId: null,
            updatedAt: self.clock.now(),
          });
          continue;
        }
        const ran = run.value;
        if (ran.status === "queued" || ran.status === "running") continue;
        yield* self.resolveOccurrenceFromRun(occurrence, ran.status);
      }
      // `pending` occurrences (enqueue failed earlier) are retried here even
      // though the schedule's nextRunAt has already advanced.
      const pending = yield* self.scheduleRepo.findOccurrences({ status: "pending" });
      for (const occurrence of pending) {
        const schedule = yield* self.scheduleRepo.findById(occurrence.scheduleId);
        if (!schedule || !schedule.enabled) continue;
        const outcome = yield* self.attemptEnqueue(schedule, occurrence);
        if (outcome === "enqueued") counters?.onEnqueued();
        if (outcome === "failed") counters?.onFailed();
      }
    });
  }

  private processDueSchedules(summary: {
    enqueued: number;
    missed: number;
    failed: number;
  }): Effect.Effect<void, unknown> {
    const self = this;
    const clock = self.clock;
    return Effect.gen(function* () {
      const now = clock.now();
      const due = yield* self.scheduleRepo.findDue(now);
      for (const schedule of due) {
        const catchUp = self.computeCatchUp(schedule, now);
        for (const at of catchUp.times) {
          const occurrence = yield* self.scheduleRepo.createOccurrence({
            id: asScheduleOccurrenceId(self.ids.generate()),
            scheduleId: schedule.id,
            scheduledFor: at,
            status: "pending",
            runId: null,
            attempts: 0,
            error: null,
            createdAt: now,
            updatedAt: now,
          } as ScheduleOccurrence);
          if (occurrence.status !== "pending") continue; // already handled (idempotent insert)
          const outcome = yield* self.attemptEnqueue(schedule, occurrence);
          if (outcome === "enqueued") summary.enqueued++;
          else if (outcome === "failed") summary.failed++;
        }
        if (catchUp.missed > 0) {
          summary.missed += catchUp.missed;
          yield* self.recordActivity("schedule.missed", "schedule", String(schedule.id), {
            scheduleId: String(schedule.id),
            skippedBacklog: catchUp.skippedBacklog,
            skippedOverCap: catchUp.missed - catchUp.skippedBacklog,
          });
        }
        // Re-read before the final update: attemptEnqueue may have persisted a
        // provisioned thread id on the schedule (scheduled-run conversation);
        // writing the stale object back would drop it.
        const fresh = yield* self.scheduleRepo.findById(schedule.id);
        yield* self.scheduleRepo.update({
          ...(fresh ?? schedule),
          nextRunAt: catchUp.nextRunAt,
          lastRunAt: now,
          updatedAt: now,
        } as Schedule);
      }
    });
  }

  /**
   * Enumerate the occurrence times a due schedule must process, honoring the
   * missed-run window (older than 2 days → skipped) and the catch-up cap.
   */
  private computeCatchUp(
    schedule: Schedule,
    now: number,
  ): {
    readonly times: readonly number[];
    readonly nextRunAt: number | null;
    readonly missed: number;
    readonly skippedBacklog: number;
  } {
    const start = schedule.nextRunAt ?? now;
    const windowStart = now - MISSED_RUN_HISTORY_WINDOW_MS;
    const times: number[] = [];
    let t: number | null = start;
    let skippedBacklog = 0;
    let missedOverCap = 0;
    while (t !== null && t <= now) {
      const next = nextScheduleFire(schedule.trigger, t, schedule.anchorAt);
      if (t < windowStart) {
        skippedBacklog++;
      } else if (times.length >= MAX_CATCH_UP_OCCURRENCES) {
        missedOverCap++;
      } else {
        times.push(t);
      }
      t = next;
    }
    return { times, nextRunAt: t, missed: skippedBacklog + missedOverCap, skippedBacklog };
  }

  private attemptEnqueue(
    schedule: Schedule,
    occurrence: ScheduleOccurrence,
  ): Effect.Effect<"enqueued" | "failed" | "retrying", unknown> {
    const self = this;
    return Effect.gen(function* () {
      // A scheduled run is a conversation between the bot and the user:
      // resolve (or provision) the schedule's thread before starting the run.
      const conversationId = yield* self.resolveScheduleConversation(schedule);
      const outcome = yield* self.runService
        .startRun({
          botId: schedule.botId,
          // The stored prompt is passed verbatim; the thread's trigger marker
          // and session context tell the bot (and user) this was scheduled.
          prompt: schedule.prompt,
          triggerType: "schedule",
          ...(conversationId !== null ? { conversationId } : {}),
        })
        .pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (run) => ({ ok: true as const, run }),
          }),
        );
      const now = self.clock.now();
      if (outcome.ok) {
        yield* self.scheduleRepo.updateOccurrence({
          ...occurrence,
          status: "enqueued",
          runId: outcome.run.id,
          error: null,
          updatedAt: now,
        });
        // Mark the trigger in the thread so the user can see (and reply to)
        // the scheduled run; system messages never trigger runs themselves.
        if (conversationId !== null) {
          yield* self.recordThreadSystemMessage(
            conversationId,
            `Scheduled run triggered (${scheduledRunTriggerDescription(schedule.trigger)})`,
          );
        }
        if (self.showSchedulingLogs) {
          console.log(
            `[schedule] run: schedule=${String(schedule.id)} run=${String(outcome.run.id)} scheduledFor=${new Date(occurrence.scheduledFor).toISOString()} prompt="${schedule.prompt}"`,
          );
        }
        yield* self.recordActivity("schedule.triggered", "schedule", String(schedule.id), {
          scheduleId: String(schedule.id),
          runId: String(outcome.run.id),
          scheduledFor: occurrence.scheduledFor,
        });
        return "enqueued";
      }
      const attempts = occurrence.attempts + 1;
      const error = describeError(outcome.error);
      if (attempts >= MAX_ENQUEUE_ATTEMPTS) {
        yield* self.scheduleRepo.updateOccurrence({
          ...occurrence,
          status: "failed",
          attempts,
          error,
          updatedAt: now,
        });
        yield* self.recordActivity("schedule.enqueued_failed", "schedule", String(schedule.id), {
          scheduleId: String(schedule.id),
          error,
          attempts,
        });
        return "failed";
      }
      yield* self.scheduleRepo.updateOccurrence({
        ...occurrence,
        attempts,
        error,
        updatedAt: now,
      });
      return "retrying";
    });
  }

  /**
   * Resolve the thread a scheduled run converses in: a fired schedule becomes
   * a conversation between that bot and the user. A schedule with no explicit
   * conversation gets its own dedicated direct thread with the human on first
   * fire; the id is persisted on the schedule so every later firing resumes
   * the same thread (and therefore the same resumable bot session). A thread
   * that was deleted is provisioned fresh. Provisioning failures degrade to
   * "no thread" — the run itself must not be blocked by decoration failures.
   */
  private resolveScheduleConversation(schedule: Schedule): Effect.Effect<ConversationId | null> {
    const self = this;
    const threads = self.threads;
    // Without a provisioning store, an explicit conversation still flows
    // through untouched (legacy behavior); there is simply no auto-thread.
    if (!threads) return Effect.succeed(schedule.conversationId ?? null);
    return Effect.gen(function* () {
      if (schedule.conversationId) {
        const existing = yield* Effect.option(
          threads.getConversation(String(schedule.conversationId)),
        );
        if (Option.isSome(existing) && existing.value !== null) {
          return schedule.conversationId;
        }
        // The thread vanished (deleted); provision a fresh one below.
      }
      const conversation = yield* Effect.option(
        threads.createConversation({
          kind: "direct",
          title: scheduleThreadTitle(schedule.prompt),
          participants: [String(schedule.botId), HUMAN_PARTICIPANT],
        }),
      );
      if (Option.isNone(conversation)) {
        yield* Effect.logError("Scheduled-run thread provisioning failed", String(schedule.id));
        return null;
      }
      // Persist the link so later firings reuse this exact thread. Failures
      // only cost a duplicate thread on the next fire, never the run.
      yield* Effect.option(
        self.scheduleRepo.update({
          ...schedule,
          conversationId: conversation.value.id,
          updatedAt: self.clock.now(),
        } as Schedule),
      );
      return conversation.value.id;
    });
  }

  /** Append a system marker to the schedule's thread; failures are ignored. */
  private recordThreadSystemMessage(conversationId: string, content: string): Effect.Effect<void> {
    const threads = this.threads;
    return Effect.gen(function* () {
      if (!threads) return;
      yield* threads
        .addMessage({ conversationId, content, senderType: "system" })
        .pipe(Effect.ignore);
    });
  }

  /** Map a terminal run status onto its occurrence. */
  private resolveOccurrenceFromRun(
    occurrence: ScheduleOccurrence,
    runStatus: "succeeded" | "failed" | "cancelled" | "timed_out",
  ): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const status =
        runStatus === "succeeded"
          ? "succeeded"
          : runStatus === "cancelled"
            ? "cancelled"
            : "failed";
      yield* self.scheduleRepo.updateOccurrence({
        ...occurrence,
        status,
        updatedAt: self.clock.now(),
      });
    });
  }

  // -- Run result hook ----------------------------------------------------

  /** Called by the RunService when a scheduled run reaches a terminal state. */
  recordRunResult(
    runId: string,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    _summary?: string,
  ): Effect.Effect<void, unknown> {
    const scheduleRepo = this.scheduleRepo;
    const clock = this.clock;
    const self = this;
    return Effect.gen(function* () {
      const occurrence = yield* scheduleRepo.findOccurrenceByRun(asRunId(runId));
      if (!occurrence || occurrence.status !== "enqueued") return;
      const nextStatus =
        status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
      yield* scheduleRepo.updateOccurrence({
        ...occurrence,
        status: nextStatus,
        error: null,
        updatedAt: clock.now(),
      });
      // Surface a failed run inside the schedule's thread: the trigger marker
      // exists, so the user should also see that no result is coming.
      if (nextStatus === "failed") {
        const schedule = yield* scheduleRepo.findById(occurrence.scheduleId);
        if (schedule?.conversationId) {
          yield* self.recordThreadSystemMessage(
            String(schedule.conversationId),
            "Scheduled run failed",
          );
        }
      }
    });
  }

  private recordActivity(
    type: string,
    entityType: string,
    entityId: string,
    payload: unknown,
  ): Effect.Effect<void> {
    const self = this;
    const activity = self.activity;
    return Effect.gen(function* () {
      if (!activity) return;
      yield* activity
        .create({
          id: asActivityId(self.ids.generate()),
          type,
          entityType,
          entityId,
          actorId: null,
          payload,
          createdAt: self.clock.now(),
        })
        .pipe(Effect.ignore);
    });
  }
}
