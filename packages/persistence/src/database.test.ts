import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, migrate, currentSchemaVersion } from "./index";

describe("openDatabase", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bebots-db-"));
    dbPath = join(dir, "app.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a database file and persists writes", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const stmt = db.prepare(
      "INSERT INTO bots (id, name, description, persona, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    stmt.run("b1", "Bot", "", "", "active", 1, 1);
    db.close();

    expect(existsSync(dbPath)).toBe(true);

    const db2 = await openDatabase(dbPath);
    const row = db2.prepare("SELECT name FROM bots WHERE id = ?").get("b1") as
      { name: string } | undefined;
    expect(row?.name).toBe("Bot");
    db2.close();
  });

  it("supports reusing a prepared statement", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const insert = db.prepare(
      "INSERT INTO bots (id, name, description, persona, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("a", "A", "", "", "active", 1, 1);
    insert.run("b", "B", "", "", "active", 2, 2);
    const rows = db.prepare("SELECT id FROM bots ORDER BY id").all();
    expect(rows).toHaveLength(2);
    db.close();
  });

  it("throws when fileMustExist and the file is missing", async () => {
    const missing = join(dir, "missing.sqlite");
    await expect(openDatabase(missing, { fileMustExist: true })).rejects.toThrow();
  });

  it("reports the current schema version", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    expect(currentSchemaVersion(db)).toBeGreaterThanOrEqual(2);
    db.close();
  });
});
