import { Effect } from "effect";
import type { Message, MessageId, ConversationId, DeliveryState } from "@bebots/domain";
import { asMessageId, asConversationId } from "@bebots/domain";
import type { MessageRepository } from "@bebots/application";
import { NotFoundError, RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

interface MessageRow {
  id: string;
  conversation_id: string;
  sender: string | null;
  sender_type: string | null;
  sender_id: string | null;
  content: string;
  reply_to: string | null;
  thread_id: string | null;
  delivery_state: string | null;
  created_at: number;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: asMessageId(row.id),
    conversationId: asConversationId(row.conversation_id),
    senderType: (row.sender_type ?? "human") as Message["senderType"],
    senderId: row.sender_id,
    content: row.content,
    ...(row.reply_to !== null && { replyTo: asMessageId(row.reply_to) }),
    ...(row.thread_id !== null && { threadId: row.thread_id }),
    deliveryState: (row.delivery_state ?? "delivered") as DeliveryState,
    createdAt: row.created_at,
  };
}

export class SqliteMessageRepository implements MessageRepository {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(message: Message): Effect.Effect<Message, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO messages (id, conversation_id, sender, sender_type, sender_id, content, reply_to, thread_id, delivery_state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          message.id,
          message.conversationId,
          null,
          message.senderType,
          message.senderId ?? null,
          message.content,
          message.replyTo ?? null,
          message.threadId ?? null,
          message.deliveryState ?? "delivered",
          message.createdAt,
        );
        return message;
      },
      catch: (cause) => new RepositoryError("Failed to create message", cause),
    });
  }

  findById(id: MessageId): Effect.Effect<Message | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(String(id)) as
          MessageRow | undefined;
        return row ? rowToMessage(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find message", cause),
    });
  }

  findByConversation(
    conversationId: ConversationId,
    options?: { readonly limit?: number; readonly before?: number },
  ): Effect.Effect<readonly Message[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses = ["conversation_id = ?"];
        const params: unknown[] = [String(conversationId)];
        if (options?.before) {
          clauses.push("created_at < ?");
          params.push(options.before);
        }
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const rows = db
          .prepare(
            `SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC ${limit}`,
          )
          .all(...params) as unknown as MessageRow[];
        return rows.map(rowToMessage);
      },
      catch: (cause) => new RepositoryError("Failed to list messages", cause),
    });
  }

  findAll(options?: {
    readonly conversationId?: ConversationId;
    readonly limit?: number;
  }): Effect.Effect<readonly Message[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options?.conversationId) {
          clauses.push("conversation_id = ?");
          params.push(String(options.conversationId));
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const rows = db
          .prepare(`SELECT * FROM messages ${where} ORDER BY created_at ASC ${limit}`)
          .all(...params) as unknown as MessageRow[];
        return rows.map(rowToMessage);
      },
      catch: (cause) => new RepositoryError("Failed to list messages", cause),
    });
  }

  update(message: Message): Effect.Effect<Message, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () =>
          db
            .prepare(
              `UPDATE messages SET conversation_id = ?, sender = ?, sender_type = ?, sender_id = ?, content = ?, reply_to = ?, thread_id = ?, delivery_state = ? WHERE id = ?`,
            )
            .run(
              message.conversationId,
              null,
              message.senderType,
              message.senderId ?? null,
              message.content,
              message.replyTo ?? null,
              message.threadId ?? null,
              message.deliveryState ?? "delivered",
              message.id,
            ).changes,
        catch: (cause) => new RepositoryError("Failed to update message", cause),
      });
      if (result === 0) return yield* Effect.fail(new NotFoundError("Message", message.id));
      return message;
    });
  }

  delete(id: MessageId): Effect.Effect<void, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => db.prepare("DELETE FROM messages WHERE id = ?").run(String(id)).changes,
        catch: (cause) => new RepositoryError("Failed to delete message", cause),
      });
      if (result === 0) return yield* Effect.fail(new NotFoundError("Message", String(id)));
    });
  }
}

export function createSqliteMessageRepository(db: SqliteDatabase): MessageRepository {
  return new SqliteMessageRepository(db);
}
export const createMessageRepository = createSqliteMessageRepository;
