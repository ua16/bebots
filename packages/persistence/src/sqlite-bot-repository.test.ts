import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  asBotId,
  avatarForMigration,
  avatarFromBotId,
  serializeBotAvatar,
} from "@bebots/domain";
import { openDatabase, migrate, createSqliteBotRepository } from "./index";

const sampleAvatar = { face: "face-1", color: 4, shape: "squircle" as const };

describe("SqliteBotRepository", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bebots-"));
    dbPath = join(dir, "app.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates and persists bots across connections", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteBotRepository(db);
    const bot = {
      id: asBotId("bot-1"),
      name: "Bot One",
      description: "desc",
      persona: "persona",
      status: "active" as const,
      avatar: sampleAvatar,
      createdAt: 100,
      updatedAt: 100,
    };
    await Effect.runPromise(repo.create(bot));
    db.close();

    const db2 = await openDatabase(dbPath);
    migrate(db2);
    const repo2 = createSqliteBotRepository(db2);
    const found = await Effect.runPromise(repo2.findById(asBotId("bot-1")));
    expect(found?.name).toBe("Bot One");
    expect(found?.avatar).toEqual(sampleAvatar);
    db2.close();
  });

  it("lists and updates bots", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteBotRepository(db);
    const bot = {
      id: asBotId("bot-2"),
      name: "Bot Two",
      description: "",
      persona: "",
      status: "active" as const,
      avatar: avatarFromBotId("bot-2"),
      createdAt: 1,
      updatedAt: 1,
    };
    await Effect.runPromise(repo.create(bot));
    const updated = {
      ...bot,
      name: "Bot Two Updated",
      avatar: { face: "face-3", color: 7, shape: "rounded-star" },
      updatedAt: 2,
    };
    await Effect.runPromise(repo.update(updated));
    const all = await Effect.runPromise(repo.findAll());
    expect(all[0]?.name).toBe("Bot Two Updated");
    expect(all[0]?.avatar).toEqual(updated.avatar);
    db.close();
  });

  it("archives filtering works", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteBotRepository(db);
    const bot = {
      id: asBotId("bot-3"),
      name: "Bot Three",
      description: "",
      persona: "",
      status: "archived" as const,
      avatar: avatarFromBotId("bot-3"),
      createdAt: 1,
      updatedAt: 1,
    };
    await Effect.runPromise(repo.create(bot));
    const active = await Effect.runPromise(repo.findAll());
    expect(active).toHaveLength(0);
    const all = await Effect.runPromise(repo.findAll({ includeArchived: true }));
    expect(all).toHaveLength(1);
    db.close();
  });

  it("persists, updates and clears a per-bot model", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteBotRepository(db);
    const bot = {
      id: asBotId("bot-4"),
      name: "Bot Four",
      description: "",
      persona: "",
      status: "active" as const,
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      avatar: avatarFromBotId("bot-4"),
      createdAt: 1,
      updatedAt: 1,
    };
    await Effect.runPromise(repo.create(bot));
    let found = await Effect.runPromise(repo.findById(asBotId("bot-4")));
    expect(found?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" });

    await Effect.runPromise(repo.update({ ...bot, model: null, updatedAt: 2 }));
    found = await Effect.runPromise(repo.findById(asBotId("bot-4")));
    expect(found?.model).toBeNull();
    db.close();
  });

  it("backfills avatar on migrate for pre-v17 bots", async () => {
    const db = await openDatabase(dbPath);
    // Apply through v16 only by inserting a bot after partial schema, then full migrate.
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        persona TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        model TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    for (let v = 1; v <= 16; v += 1) {
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(v, `v${v}`, 1);
    }
    db.prepare(
      "INSERT INTO bots (id, name, description, persona, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("legacy-bot", "Legacy", "", "", "active", "", 1, 1);

    migrate(db);
    const repo = createSqliteBotRepository(db);
    const found = await Effect.runPromise(repo.findById(asBotId("legacy-bot")));
    expect(found?.avatar).toEqual(avatarForMigration("legacy-bot"));
    const raw = db.prepare("SELECT avatar FROM bots WHERE id = ?").get("legacy-bot") as {
      avatar: string;
    };
    expect(raw.avatar).toBe(serializeBotAvatar(avatarForMigration("legacy-bot")));
    db.close();
  });
});
