import { Effect } from "effect";
import type { ActivityEvent } from "@bebots/domain";
import { asActivityId } from "@bebots/domain";
import type { ActivityRepository } from "@bebots/application";
import { RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

interface ActivityRow {
  id: string;
  type: string;
  entity_type: string;
  entity_id: string;
  actor_id: string | null;
  payload: string | null;
  created_at: number;
}

function rowToEvent(row: ActivityRow): ActivityEvent {
  let payload: unknown;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
  }
  return {
    id: asActivityId(row.id),
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorId: row.actor_id,
    payload,
    createdAt: row.created_at,
  };
}

export class SqliteActivityRepository implements ActivityRepository {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(event: ActivityEvent): Effect.Effect<ActivityEvent, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO activity_events (id, type, entity_type, entity_id, actor_id, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.id,
          event.type,
          event.entityType,
          event.entityId,
          event.actorId ?? null,
          event.payload !== undefined ? JSON.stringify(event.payload) : null,
          event.createdAt,
        );
        return event;
      },
      catch: (cause) => new RepositoryError("Failed to create activity event", cause),
    });
  }

  findAll(options?: {
    readonly type?: string;
    readonly entityType?: string;
    readonly entityId?: string;
    readonly limit?: number;
  }): Effect.Effect<readonly ActivityEvent[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options?.type !== undefined) {
          clauses.push("type = ?");
          params.push(options.type);
        }
        if (options?.entityType !== undefined) {
          clauses.push("entity_type = ?");
          params.push(options.entityType);
        }
        if (options?.entityId !== undefined) {
          clauses.push("entity_id = ?");
          params.push(options.entityId);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const rows = db
          .prepare(`SELECT * FROM activity_events ${where} ORDER BY created_at DESC ${limit}`)
          .all(...params) as unknown as ActivityRow[];
        return rows.map(rowToEvent);
      },
      catch: (cause) => new RepositoryError("Failed to list activity events", cause),
    });
  }

  deleteByEntityIds(
    entityType: string,
    entityIds: readonly string[],
  ): Effect.Effect<number, RepositoryError> {
    const db = this.db;
    if (entityIds.length === 0) return Effect.succeed(0);
    const placeholders = entityIds.map(() => "?").join(", ");
    return Effect.try({
      try: () =>
        db
          .prepare(
            `DELETE FROM activity_events WHERE entity_type = ? AND entity_id IN (${placeholders})`,
          )
          .run(entityType, ...entityIds).changes,
      catch: (cause) => new RepositoryError("Failed to delete activity events", cause),
    });
  }
}

export function createSqliteActivityRepository(db: SqliteDatabase): ActivityRepository {
  return new SqliteActivityRepository(db);
}
