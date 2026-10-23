import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { openDatabase, migrate, createSqliteSettingsRepository } from "./index";

describe("SqliteSettingsRepository", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bebots-"));
    dbPath = join(dir, "app.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a setting across connections", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteSettingsRepository(db);
    await Effect.runPromise(repo.set("default_model", "value-1"));
    db.close();

    const db2 = await openDatabase(dbPath);
    migrate(db2);
    const repo2 = createSqliteSettingsRepository(db2);
    const value = await Effect.runPromise(repo2.get("default_model"));
    expect(value).toBe("value-1");
    db2.close();
  });

  it("overwrites on set and returns null for unknown keys", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteSettingsRepository(db);
    await Effect.runPromise(repo.set("k", "a"));
    await Effect.runPromise(repo.set("k", "b"));
    expect(await Effect.runPromise(repo.get("k"))).toBe("b");
    expect(await Effect.runPromise(repo.get("missing"))).toBeNull();
    db.close();
  });
});
