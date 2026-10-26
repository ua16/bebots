import { Effect } from "effect";
import type {
  Schedule,
  ScheduleId,
  ScheduleOccurrence,
  ScheduleOccurrenceStatus,
} from "@bebots/domain";
import {
  asBotId,
  asScheduleId,
  asScheduleOccurrenceId,
  validateScheduleTrigger,
} from "@bebots/domain";
import type { ScheduleRepository } from "@bebots/application";
import { NotFoundError, RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

interface ScheduleRow {
  id: string;
  bot_id: string;
  prompt: string;
  trigger: string;
  conversation_id: string | null;
  created_by: string | null;
  enabled: number;
  anchor_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface OccurrenceRow {
  id: string;
  schedule_id: string;
  scheduled_for: number;
  status: string;
  run_id: string | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSchedule(row: ScheduleRow): Schedule | null {
  let trigger: unknown;
  try {
    trigger = JSON.parse(row.trigger);
  } catch {
    return null;
  }
  const validated = validateScheduleTrigger(trigger);
  if (!validated.valid) return null;
  return {
    id: asScheduleId(row.id),
    botId: asBotId(row.bot_id),
    prompt: row.prompt,
    trigger: validated.value,
    enabled: row.enabled === 1,
    conversationId: row.conversation_id ?? null,
    createdBy: row.created_by,
    anchorAt: row.anchor_at,
    nextRunAt: row.next_run_at ?? null,
    lastRunAt: row.last_run_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as Schedule;
}

function rowToOccurrence(row: OccurrenceRow): ScheduleOccurrence {
  return {
    id: asScheduleOccurrenceId(row.id),
    scheduleId: asScheduleId(row.schedule_id),
    scheduledFor: row.scheduled_for,
    status: row.status as ScheduleOccurrenceStatus,
    runId: row.run_id ? row.run_id : undefined,
    attempts: row.attempts,
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as ScheduleOccurrence;
}

export class SqliteScheduleRepository implements ScheduleRepository {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(schedule: Schedule): Effect.Effect<Schedule, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO schedules (id, bot_id, prompt, trigger, conversation_id, created_by, enabled, anchor_at, next_run_at, last_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          schedule.id,
          schedule.botId,
          schedule.prompt,
          JSON.stringify(schedule.trigger),
          schedule.conversationId ?? null,
          schedule.createdBy ?? null,
          schedule.enabled ? 1 : 0,
          schedule.anchorAt,
          schedule.nextRunAt ?? null,
          schedule.lastRunAt ?? null,
          schedule.createdAt,
          schedule.updatedAt,
        );
        return schedule;
      },
      catch: (cause) => new RepositoryError("Failed to create schedule", cause),
    });
  }

  findById(id: ScheduleId): Effect.Effect<Schedule | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(String(id)) as
          ScheduleRow | undefined;
        return row ? rowToSchedule(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find schedule", cause),
    });
  }

  findAll(options?: {
    readonly botId?: string;
    readonly enabled?: boolean;
    readonly createdBy?: string;
    readonly limit?: number;
  }): Effect.Effect<readonly Schedule[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options?.botId !== undefined) {
          clauses.push("bot_id = ?");
          params.push(options.botId);
        }
        if (options?.enabled !== undefined) {
          clauses.push("enabled = ?");
          params.push(options.enabled ? 1 : 0);
        }
        if (options?.createdBy !== undefined) {
          clauses.push("created_by = ?");
          params.push(options.createdBy);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const rows = db
          .prepare(`SELECT * FROM schedules ${where} ORDER BY created_at DESC ${limit}`)
          .all(...params) as unknown as ScheduleRow[];
        return rows.map(rowToSchedule).filter((s): s is Schedule => s !== null);
      },
      catch: (cause) => new RepositoryError("Failed to list schedules", cause),
    });
  }

  findDue(now: number): Effect.Effect<readonly Schedule[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const rows = db
          .prepare(
            "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
          )
          .all(now) as unknown as ScheduleRow[];
        return rows.map(rowToSchedule).filter((s): s is Schedule => s !== null);
      },
      catch: (cause) => new RepositoryError("Failed to find due schedules", cause),
    });
  }

  update(schedule: Schedule): Effect.Effect<Schedule, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const changes = yield* Effect.try({
        try: () =>
          db
            .prepare(
              `UPDATE schedules SET bot_id = ?, prompt = ?, trigger = ?, conversation_id = ?, created_by = ?, enabled = ?, anchor_at = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              schedule.botId,
              schedule.prompt,
              JSON.stringify(schedule.trigger),
              schedule.conversationId ?? null,
              schedule.createdBy ?? null,
              schedule.enabled ? 1 : 0,
              schedule.anchorAt,
              schedule.nextRunAt ?? null,
              schedule.lastRunAt ?? null,
              schedule.updatedAt,
              schedule.id,
            ).changes,
        catch: (cause) => new RepositoryError("Failed to update schedule", cause),
      });
      if (changes === 0)
        return yield* Effect.fail(new NotFoundError("Schedule", String(schedule.id)));
      return schedule;
    });
  }

  delete(id: ScheduleId): Effect.Effect<void, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const changes = yield* Effect.try({
        try: () => db.prepare("DELETE FROM schedules WHERE id = ?").run(String(id)).changes,
        catch: (cause) => new RepositoryError("Failed to delete schedule", cause),
      });
      if (changes === 0) return yield* Effect.fail(new NotFoundError("Schedule", String(id)));
    }) as Effect.Effect<void, RepositoryError | NotFoundError>;
  }

  /**
   * Idempotent insert: conflicting rows for a (scheduleId, scheduledFor) slot
   * return the existing occurrence untouched (unique index enforces this).
   */
  createOccurrence(
    occurrence: ScheduleOccurrence,
  ): Effect.Effect<ScheduleOccurrence, RepositoryError> {
    const db = this.db;
    return Effect.gen(function* () {
      yield* Effect.try({
        try: () => {
          db.prepare(
            `INSERT OR IGNORE INTO schedule_occurrences (id, schedule_id, scheduled_for, status, run_id, attempts, error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            occurrence.id,
            occurrence.scheduleId,
            occurrence.scheduledFor,
            occurrence.status,
            occurrence.runId ?? null,
            occurrence.attempts,
            occurrence.error ?? null,
            occurrence.createdAt,
            occurrence.updatedAt,
          );
        },
        catch: (cause) => new RepositoryError("Failed to create schedule occurrence", cause),
      });
      const find = yield* Effect.try({
        try: () =>
          db
            .prepare(
              "SELECT * FROM schedule_occurrences WHERE schedule_id = ? AND scheduled_for = ?",
            )
            .all(
              String(occurrence.scheduleId),
              occurrence.scheduledFor,
            ) as unknown as OccurrenceRow[],
        catch: (cause) => new RepositoryError("Failed to find schedule occurrence", cause),
      });
      return rowToOccurrence(find[0]!);
    });
  }

  findOccurrence(
    id: ScheduleOccurrence["id"],
  ): Effect.Effect<ScheduleOccurrence | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db
          .prepare("SELECT * FROM schedule_occurrences WHERE id = ?")
          .get(String(id)) as OccurrenceRow | undefined;
        return row ? rowToOccurrence(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find schedule occurrence", cause),
    });
  }

  findOccurrenceByRun(runId: string): Effect.Effect<ScheduleOccurrence | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db
          .prepare(
            "SELECT * FROM schedule_occurrences WHERE run_id = ? ORDER BY scheduled_for DESC",
          )
          .get(String(runId)) as OccurrenceRow | undefined;
        return row ? rowToOccurrence(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find schedule occurrence by run", cause),
    });
  }

  listOccurrences(
    scheduleId: ScheduleId,
    options?: { readonly limit?: number },
  ): Effect.Effect<readonly ScheduleOccurrence[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const rows = db
          .prepare(
            `SELECT * FROM schedule_occurrences WHERE schedule_id = ? ORDER BY scheduled_for DESC ${limit}`,
          )
          .all(String(scheduleId)) as unknown as OccurrenceRow[];
        return rows.map(rowToOccurrence);
      },
      catch: (cause) => new RepositoryError("Failed to list schedule occurrences", cause),
    });
  }

  findOccurrences(options?: {
    readonly status?: ScheduleOccurrenceStatus;
    readonly limit?: number;
  }): Effect.Effect<readonly ScheduleOccurrence[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options?.status !== undefined) {
          clauses.push("status = ?");
          params.push(options.status);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const rows = db
          .prepare(
            `SELECT * FROM schedule_occurrences ${where} ORDER BY scheduled_for ASC ${limit}`,
          )
          .all(...params) as unknown as OccurrenceRow[];
        return rows.map(rowToOccurrence);
      },
      catch: (cause) => new RepositoryError("Failed to find schedule occurrences", cause),
    });
  }

  updateOccurrence(
    occurrence: ScheduleOccurrence,
  ): Effect.Effect<ScheduleOccurrence, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const changes = yield* Effect.try({
        try: () =>
          db
            .prepare(
              `UPDATE schedule_occurrences SET status = ?, run_id = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              occurrence.status,
              occurrence.runId ?? null,
              occurrence.attempts,
              occurrence.error ?? null,
              occurrence.updatedAt,
              occurrence.id,
            ).changes,
        catch: (cause) => new RepositoryError("Failed to update schedule occurrence", cause),
      });
      if (changes === 0) {
        return yield* Effect.fail(new NotFoundError("ScheduleOccurrence", String(occurrence.id)));
      }
      return occurrence;
    });
  }

  deleteOccurrences(scheduleId: ScheduleId): Effect.Effect<number, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () =>
        db.prepare("DELETE FROM schedule_occurrences WHERE schedule_id = ?").run(String(scheduleId))
          .changes,
      catch: (cause) => new RepositoryError("Failed to delete schedule occurrences", cause),
    });
  }
}

export function createSqliteScheduleRepository(db: SqliteDatabase): ScheduleRepository {
  return new SqliteScheduleRepository(db);
}
