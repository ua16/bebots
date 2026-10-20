import { Effect } from "effect";
import type { BotId } from "@bebots/domain";
import type { FileIndexEntry, FileIndexRepository, FileIndexSearchHit } from "@bebots/application";
import { RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

export class SqliteFileIndexRepository implements FileIndexRepository {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  upsert(entry: FileIndexEntry): Effect.Effect<FileIndexEntry, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO file_index (bot_id, path, kind, content, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(bot_id, path)
           DO UPDATE SET kind = excluded.kind, content = excluded.content, updated_at = excluded.updated_at`,
        ).run(entry.botId, entry.path, entry.kind, entry.content, entry.updatedAt);
        return entry;
      },
      catch: (cause) => new RepositoryError("Failed to upsert file index entry", cause),
    });
  }

  remove(botId: BotId, path: string): Effect.Effect<void, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare("DELETE FROM file_index WHERE bot_id = ? AND path = ?").run(String(botId), path);
      },
      catch: (cause) => new RepositoryError("Failed to remove file index entry", cause),
    });
  }

  removeUnderPrefix(botId: BotId, pathPrefix: string): Effect.Effect<number, RepositoryError> {
    const db = this.db;
    const prefix = pathPrefix.endsWith("/") || pathPrefix === "" ? pathPrefix : `${pathPrefix}/`;
    return Effect.try({
      try: () => {
        const rows = db
          .prepare("SELECT id, path FROM file_index WHERE bot_id = ?")
          .all(String(botId)) as unknown as { id: number; path: string }[];
        const toDelete = rows.filter(
          (row) => row.path === pathPrefix || (prefix !== "" && row.path.startsWith(prefix)),
        );
        let removed = 0;
        for (const row of toDelete) {
          removed += db.prepare("DELETE FROM file_index WHERE id = ?").run(row.id).changes;
        }
        return removed;
      },
      catch: (cause) => new RepositoryError("Failed to prune file index", cause),
    });
  }

  search(
    query: string,
    botId?: BotId,
  ): Effect.Effect<readonly FileIndexSearchHit[], RepositoryError> {
    const db = this.db;
    const q = `%${query}%`;
    return Effect.try({
      try: () => {
        const rows = botId
          ? db
              .prepare(
                "SELECT bot_id, path, content FROM file_index WHERE bot_id = ? AND content LIKE ? ORDER BY updated_at DESC",
              )
              .all(String(botId), q)
          : db
              .prepare(
                "SELECT bot_id, path, content FROM file_index WHERE content LIKE ? ORDER BY updated_at DESC",
              )
              .all(q);
        return (rows as unknown as { bot_id: string; path: string; content: string }[]).map(
          (row) => ({
            botId: row.bot_id as BotId,
            path: row.path,
            snippet: String(row.content ?? "").slice(0, 200),
          }),
        );
      },
      catch: (cause) => new RepositoryError("Failed to search file index", cause),
    });
  }
}

export function createSqliteFileIndexRepository(db: SqliteDatabase): FileIndexRepository {
  return new SqliteFileIndexRepository(db);
}
