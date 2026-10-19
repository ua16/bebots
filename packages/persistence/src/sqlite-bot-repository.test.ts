import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { asBotId } from "@bebots/domain";
import { openDatabase, migrate, createSqliteBotRepository } from "./index";

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
      createdAt: 1,
      updatedAt: 1,
    };
    await Effect.runPromise(repo.create(bot));
    const updated = { ...bot, name: "Bot Two Updated", updatedAt: 2 };
    await Effect.runPromise(repo.update(updated));
    const all = await Effect.runPromise(repo.findAll());
    expect(all[0]?.name).toBe("Bot Two Updated");
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
});
