import { Effect } from "effect";
import type { SettingsRepository } from "@bebots/application";
import { RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

/** Simple key/value storage for app-wide mutable settings (app_settings table). */
export class SqliteSettingsRepository implements SettingsRepository {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  get(key: string): Effect.Effect<string | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
          | { value: string }
          | undefined;
        return row?.value ?? null;
      },
      catch: (cause: unknown) => new RepositoryError("Failed to read setting", cause),
    });
  }

  set(key: string, value: string): Effect.Effect<void, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(key, value);
      },
      catch: (cause: unknown) => new RepositoryError("Failed to write setting", cause),
    });
  }
}

export function createSqliteSettingsRepository(db: SqliteDatabase): SettingsRepository {
  return new SqliteSettingsRepository(db);
}
