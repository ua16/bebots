import { Effect } from "effect";
import type { ConversationSession, ConversationSessionId, ConversationId } from "@bebots/domain";
import { asConversationSessionId, asConversationId } from "@bebots/domain";
import type { ConversationSessionRepository } from "@bebots/application";
import { NotFoundError, RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

interface SessionRow {
  id: string;
  conversation_id: string;
  runtime_session_id: string;
  status: string;
  last_used_at: number;
  created_at: number;
  updated_at: number;
  bot_id: string | null;
}

function rowToSession(row: SessionRow): ConversationSession {
  return {
    id: asConversationSessionId(row.id),
    conversationId: asConversationId(row.conversation_id),
    runtimeSessionId: row.runtime_session_id,
    botId: row.bot_id ?? null,
    lastUsedAt: row.last_used_at,
    status: row.status as ConversationSession["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteConversationSessionRepository implements ConversationSessionRepository {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(session: ConversationSession): Effect.Effect<ConversationSession, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO conversation_sessions (id, conversation_id, runtime_session_id, bot_id, status, last_used_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          session.id,
          session.conversationId,
          session.runtimeSessionId,
          session.botId ?? null,
          session.status,
          session.lastUsedAt,
          session.createdAt,
          session.updatedAt,
        );
        return session;
      },
      catch: (cause) => new RepositoryError("Failed to create conversation session", cause),
    });
  }

  findById(id: ConversationSessionId): Effect.Effect<ConversationSession | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db
          .prepare("SELECT * FROM conversation_sessions WHERE id = ?")
          .get(String(id)) as SessionRow | undefined;
        return row ? rowToSession(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find conversation session", cause),
    });
  }

  findLatestByConversation(
    conversationId: ConversationId,
    options?: {
      readonly status?: ConversationSession["status"];
      /** Restrict to sessions of this bot; legacy rows store SQL NULL. */
      readonly botId?: string | null;
    },
  ): Effect.Effect<ConversationSession | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses = ["conversation_id = ?"];
        const params: unknown[] = [String(conversationId)];
        if (options?.status) {
          clauses.push("status = ?");
          params.push(options.status);
        }
        if (options?.botId !== undefined) {
          if (options.botId === null) {
            // Unattributed (legacy) rows: SQL NULL needs IS NULL, not = NULL.
            clauses.push("bot_id IS NULL");
          } else {
            clauses.push("bot_id = ?");
            params.push(options.botId);
          }
        }
        const row = db
          .prepare(
            `SELECT * FROM conversation_sessions WHERE ${clauses.join(" AND ")} ORDER BY last_used_at DESC LIMIT 1`,
          )
          .get(...params) as SessionRow | undefined;
        return row ? rowToSession(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find latest conversation session", cause),
    });
  }

  findAll(options?: {
    readonly conversationId?: ConversationId;
    readonly status?: string;
    readonly limit?: number;
  }): Effect.Effect<readonly ConversationSession[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options?.conversationId) {
          clauses.push("conversation_id = ?");
          params.push(String(options.conversationId));
        }
        if (options?.status) {
          clauses.push("status = ?");
          params.push(options.status);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        // In-SQL paging: the interface's `limit` clause must not pull every
        // row into memory.
        const limitClause = options?.limit !== undefined ? " LIMIT ?" : "";
        const allParams = options?.limit !== undefined ? [...params, options.limit] : params;
        const rows = db
          .prepare(
            `SELECT * FROM conversation_sessions ${where} ORDER BY last_used_at DESC${limitClause}`,
          )
          .all(...allParams) as unknown as SessionRow[];
        return rows.map(rowToSession);
      },
      catch: (cause) => new RepositoryError("Failed to list conversation sessions", cause),
    });
  }

  update(
    session: ConversationSession,
  ): Effect.Effect<ConversationSession, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () =>
          db
            .prepare(
              `UPDATE conversation_sessions SET conversation_id = ?, runtime_session_id = ?, bot_id = ?, status = ?, last_used_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              session.conversationId,
              session.runtimeSessionId,
              session.botId ?? null,
              session.status,
              session.lastUsedAt,
              session.updatedAt,
              session.id,
            ).changes,
        catch: (cause) => new RepositoryError("Failed to update conversation session", cause),
      });
      if (result === 0)
        return yield* Effect.fail(new NotFoundError("ConversationSession", session.id));
      return session;
    });
  }

  delete(id: ConversationSessionId): Effect.Effect<void, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () =>
          db.prepare("DELETE FROM conversation_sessions WHERE id = ?").run(String(id)).changes,
        catch: (cause) => new RepositoryError("Failed to delete conversation session", cause),
      });
      if (result === 0)
        return yield* Effect.fail(new NotFoundError("ConversationSession", String(id)));
    });
  }
}

export function createSqliteConversationSessionRepository(
  db: SqliteDatabase,
): ConversationSessionRepository {
  return new SqliteConversationSessionRepository(db);
}
