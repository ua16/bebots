/** Shared test helper: per-test temp SQLite database with migrations applied. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { openDatabase, type SqliteDatabase } from "./database.js";
import { migrate } from "./migrations.js";

export interface TempDatabase {
  /** Open a migrated database for the current test. */
  readonly open: () => Promise<SqliteDatabase>;
  readonly close: (db: SqliteDatabase) => void;
}

export function withTempDatabase(): TempDatabase {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bebots-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  return {
    open: async () => {
      const db = await openDatabase(join(dir, "app.sqlite"));
      migrate(db);
      return db;
    },
    close: (db) => db.close(),
  };
}
