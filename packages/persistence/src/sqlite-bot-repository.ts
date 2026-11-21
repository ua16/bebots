import { Effect } from "effect";
import type { Bot, BotId } from "@bebots/domain";
import {
  asBotId,
  avatarFromBotId,
  parseBotAvatar,
  parseModelRef,
  serializeBotAvatar,
  serializeModelRef,
} from "@bebots/domain";
import type { BotRepository } from "@bebots/application";
import { NotFoundError, RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

interface BotRow {
  id: string;
  name: string;
  description: string;
  persona: string;
  status: string;
  /** JSON-encoded ModelRef, or '' when unset. */
  model: string;
  /** JSON-encoded BotAvatar, or '' when unset (pre-backfill / corrupt). */
  avatar: string;
  created_at: number;
  updated_at: number;
}

function rowToBot(row: BotRow): Bot {
  return {
    id: asBotId(row.id),
    name: row.name,
    description: row.description,
    persona: row.persona,
    status: row.status as Bot["status"],
    model: parseModelRef(row.model),
    avatar: parseBotAvatar(row.avatar) ?? avatarFromBotId(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteBotRepository implements BotRepository {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(bot: Bot): Effect.Effect<Bot, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO bots (id, name, description, persona, status, model, avatar, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          bot.id,
          bot.name,
          bot.description,
          bot.persona,
          bot.status,
          serializeModelRef(bot.model),
          serializeBotAvatar(bot.avatar),
          bot.createdAt,
          bot.updatedAt,
        );
        return bot;
      },
      catch: (cause: unknown) => new RepositoryError("Failed to create bot", cause),
    });
  }

  findById(id: BotId): Effect.Effect<Bot | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as BotRow | undefined;
        return row ? rowToBot(row) : null;
      },
      catch: (cause: unknown) => new RepositoryError("Failed to find bot", cause),
    });
  }

  findAll(options?: {
    readonly includeArchived?: boolean;
  }): Effect.Effect<readonly Bot[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const sql = options?.includeArchived
          ? "SELECT * FROM bots ORDER BY created_at ASC"
          : "SELECT * FROM bots WHERE status != 'archived' ORDER BY created_at ASC";
        const rows = db.prepare(sql).all() as unknown as BotRow[];
        return rows.map(rowToBot);
      },
      catch: (cause: unknown) => new RepositoryError("Failed to list bots", cause),
    });
  }

  update(bot: Bot): Effect.Effect<Bot, RepositoryError | NotFoundError> {
    const { db } = this;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => {
          const info = db
            .prepare(
              `UPDATE bots
               SET name = ?, description = ?, persona = ?, status = ?, model = ?, avatar = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              bot.name,
              bot.description,
              bot.persona,
              bot.status,
              serializeModelRef(bot.model),
              serializeBotAvatar(bot.avatar),
              bot.updatedAt,
              bot.id,
            );
          return info.changes;
        },
        catch: (cause: unknown) => new RepositoryError("Failed to update bot", cause),
      });
      if (result === 0) {
        return yield* Effect.fail(new NotFoundError("Bot", bot.id));
      }
      return bot;
    });
  }

  delete(id: BotId): Effect.Effect<void, RepositoryError | NotFoundError> {
    const { db } = this;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => db.prepare("DELETE FROM bots WHERE id = ?").run(id).changes,
        catch: (cause: unknown) => new RepositoryError("Failed to delete bot", cause),
      });
      if (result === 0) {
        return yield* Effect.fail(new NotFoundError("Bot", id));
      }
    });
  }
}

export function createSqliteBotRepository(db: SqliteDatabase): BotRepository {
  return new SqliteBotRepository(db);
}
