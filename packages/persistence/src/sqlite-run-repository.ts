import { Effect } from "effect";
import type {
  BotId,
  Run,
  RunId,
  RunStatus,
  ConversationId,
  ConversationSessionId,
  TaskId,
} from "@bebots/domain";
import { asBotId, asRunId } from "@bebots/domain";
import type { RunRepository } from "@bebots/application";
import { NotFoundError, RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

interface RunRow {
  id: string;
  bot_id: string;
  trigger_type: string;
  prompt: string;
  status: string;
  session_id: string | null;
  timeout_ms: number;
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  summary: string | null;
  error: string | null;
  conversation_id: string | null;
  conversation_session_id: string | null;
  task_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToRun(row: RunRow): Run {
  return {
    id: asRunId(row.id),
    botId: asBotId(row.bot_id),
    triggerType: row.trigger_type as Run["triggerType"],
    prompt: row.prompt,
    status: row.status as RunStatus,
    sessionId: row.session_id ?? undefined,
    timeoutMs: row.timeout_ms,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    conversationId: row.conversation_id ? (row.conversation_id as ConversationId) : undefined,
    conversationSessionId: row.conversation_session_id
      ? (row.conversation_session_id as ConversationSessionId)
      : undefined,
    taskId: row.task_id ? (row.task_id as TaskId) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as Run;
}

export class SqliteRunRepository implements RunRepository {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(run: Run): Effect.Effect<Run, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO runs (id, bot_id, trigger_type, prompt, status, session_id, timeout_ms, started_at, ended_at, exit_code, summary, error, conversation_id, conversation_session_id, task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          run.id,
          run.botId,
          run.triggerType,
          run.prompt,
          run.status,
          run.sessionId ?? null,
          run.timeoutMs,
          run.startedAt ?? null,
          run.endedAt ?? null,
          run.exitCode ?? null,
          run.summary ?? null,
          run.error ?? null,
          run.conversationId ?? null,
          run.conversationSessionId ?? null,
          run.taskId ?? null,
          run.createdAt,
          run.updatedAt,
        );
        return run;
      },
      catch: (cause: unknown) => new RepositoryError("Failed to create run", cause),
    });
  }

  findById(id: RunId): Effect.Effect<Run | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
        return row ? rowToRun(row) : null;
      },
      catch: (cause: unknown) => new RepositoryError("Failed to find run", cause),
    });
  }

  findAll(options?: {
    readonly botId?: BotId;
    readonly status?: RunStatus;
    readonly conversationId?: ConversationId;
    readonly limit?: number;
  }): Effect.Effect<readonly Run[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options?.botId) {
          clauses.push("bot_id = ?");
          params.push(options.botId);
        }
        if (options?.status) {
          clauses.push("status = ?");
          params.push(options.status);
        }
        if (options?.conversationId) {
          clauses.push("conversation_id = ?");
          params.push(options.conversationId);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const sql = `SELECT * FROM runs ${where} ORDER BY created_at DESC ${limit}`;
        const rows = db.prepare(sql).all(...params) as unknown as RunRow[];
        return rows.map(rowToRun);
      },
      catch: (cause: unknown) => new RepositoryError("Failed to list runs", cause),
    });
  }

  update(run: Run): Effect.Effect<Run, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => {
          const info = db
            .prepare(
              `UPDATE runs
               SET bot_id = ?, trigger_type = ?, prompt = ?, status = ?, session_id = ?, timeout_ms = ?, started_at = ?, ended_at = ?, exit_code = ?, summary = ?, error = ?, conversation_id = ?, conversation_session_id = ?, task_id = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              run.botId,
              run.triggerType,
              run.prompt,
              run.status,
              run.sessionId ?? null,
              run.timeoutMs,
              run.startedAt ?? null,
              run.endedAt ?? null,
              run.exitCode ?? null,
              run.summary ?? null,
              run.error ?? null,
              run.conversationId ?? null,
              run.conversationSessionId ?? null,
              run.taskId ?? null,
              run.updatedAt,
              run.id,
            );
          return info.changes;
        },
        catch: (cause: unknown) => new RepositoryError("Failed to update run", cause),
      });
      if (result === 0) {
        return yield* Effect.fail(new NotFoundError("Run", run.id));
      }
      return run;
    });
  }

  appendEvent(
    runId: RunId,
    event: { readonly _tag: string; readonly [key: string]: unknown },
  ): Effect.Effect<void, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO run_events (run_id, tag, payload, created_at) VALUES (?, ?, ?, ?)`,
        ).run(runId, event._tag, JSON.stringify(event), Date.now());
      },
      catch: (cause: unknown) => new RepositoryError("Failed to append run event", cause),
    });
  }

  listEvents(
    runId: RunId,
  ): Effect.Effect<
    readonly { readonly tag: string; readonly payload: unknown; readonly createdAt: number }[],
    RepositoryError
  > {
    const db = this.db;
    return Effect.try({
      try: () => {
        const rows = db
          .prepare(
            "SELECT tag, payload, created_at FROM run_events WHERE run_id = ? ORDER BY id ASC",
          )
          .all(runId) as unknown as { tag: string; payload: string; created_at: number }[];
        return rows.map((r) => ({
          tag: r.tag,
          payload: JSON.parse(r.payload),
          createdAt: r.created_at,
        }));
      },
      catch: (cause: unknown) => new RepositoryError("Failed to list run events", cause),
    });
  }

  /**
   * Delete every run matching a column predicate together with its run_events.
   * Events go first (children before parents); both statements target the same
   * predicate, so a crash between them can only leave orphan events, never
   * orphan-free runs or resurrected parents.
   */
  private deleteWhere(column: "bot_id" | "conversation_id", value: string) {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE ${column} = ?)`,
        ).run(value);
        const runs = db.prepare(`DELETE FROM runs WHERE ${column} = ?`).run(value).changes;
        return runs;
      },
      catch: (cause: unknown) => new RepositoryError("Failed to delete runs", cause),
    });
  }

  deleteByBot(botId: BotId): Effect.Effect<number, RepositoryError> {
    return this.deleteWhere("bot_id", String(botId));
  }

  deleteByConversation(conversationId: ConversationId): Effect.Effect<number, RepositoryError> {
    return this.deleteWhere("conversation_id", String(conversationId));
  }
}

export function createSqliteRunRepository(db: SqliteDatabase): RunRepository {
  return new SqliteRunRepository(db);
}
