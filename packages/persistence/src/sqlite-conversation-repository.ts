import { Effect } from "effect";
import type { Conversation, ConversationId, ConversationKind } from "@bebots/domain";
import { asConversationId } from "@bebots/domain";
import type { ConversationRepository } from "@bebots/application";
import { NotFoundError, RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

interface ConversationRow {
  id: string;
  kind: string;
  title: string;
  participants: string;
  created_at: number;
  updated_at: number;
}

function rowToConversation(row: ConversationRow): Conversation {
  let participants: string[] = [];
  try {
    const parsed = JSON.parse(row.participants);
    if (Array.isArray(parsed)) participants = parsed.map(String);
  } catch {
    participants = [];
  }
  return {
    id: asConversationId(row.id),
    kind: row.kind as ConversationKind,
    title: row.title,
    participants,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteConversationRepository implements ConversationRepository {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(conversation: Conversation): Effect.Effect<Conversation, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const participants = JSON.stringify(conversation.participants ?? []);
        db.prepare(
          `INSERT INTO conversations (id, kind, title, participants, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          conversation.id,
          conversation.kind,
          conversation.title ?? "",
          participants,
          conversation.createdAt,
          conversation.updatedAt,
        );
        return conversation;
      },
      catch: (cause) => new RepositoryError("Failed to create conversation", cause),
    });
  }

  findById(id: ConversationId): Effect.Effect<Conversation | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(String(id)) as
          ConversationRow | undefined;
        return row ? rowToConversation(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find conversation", cause),
    });
  }

  findAll(options?: {
    readonly kind?: ConversationKind;
    readonly participant?: string;
    readonly limit?: number;
  }): Effect.Effect<readonly Conversation[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options?.kind) {
          clauses.push("kind = ?");
          params.push(options.kind);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const rows = db
          .prepare(`SELECT * FROM conversations ${where} ORDER BY created_at DESC ${limit}`)
          .all(...params) as unknown as ConversationRow[];
        let result = rows.map(rowToConversation);
        if (options?.participant) {
          result = result.filter((c) =>
            (c.participants ?? []).includes(options.participant as string),
          );
        }
        return result;
      },
      catch: (cause) => new RepositoryError("Failed to list conversations", cause),
    });
  }

  update(conversation: Conversation): Effect.Effect<Conversation, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const participants = JSON.stringify(conversation.participants ?? []);
      const result = yield* Effect.try({
        try: () =>
          db
            .prepare(
              `UPDATE conversations SET kind = ?, title = ?, participants = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              conversation.kind,
              conversation.title ?? "",
              participants,
              conversation.updatedAt,
              conversation.id,
            ).changes,
        catch: (cause) => new RepositoryError("Failed to update conversation", cause),
      });
      if (result === 0)
        return yield* Effect.fail(new NotFoundError("Conversation", conversation.id));
      return conversation;
    });
  }

  delete(id: ConversationId): Effect.Effect<void, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => db.prepare("DELETE FROM conversations WHERE id = ?").run(String(id)).changes,
        catch: (cause) => new RepositoryError("Failed to delete conversation", cause),
      });
      if (result === 0) return yield* Effect.fail(new NotFoundError("Conversation", String(id)));
    });
  }
}

export function createSqliteConversationRepository(db: SqliteDatabase): ConversationRepository {
  return new SqliteConversationRepository(db);
}
