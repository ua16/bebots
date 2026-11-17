import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { BotId } from "@bebots/domain";
import { asBotId } from "@bebots/domain";
import { createSqliteFileIndexRepository } from "./sqlite-file-index-repository.js";
import { withTempDatabase } from "./test-helpers.js";

describe("SqliteFileIndexRepository", () => {
  const temp = withTempDatabase();

  it("upserts without duplicating (unique bot_id + path)", async () => {
    const db = await temp.open();
    const repo = createSqliteFileIndexRepository(db);
    const botId = asBotId("bot-1");
    await Effect.runPromise(
      repo.upsert({
        botId,
        path: "bot-1/notes/topic.md",
        kind: "notes",
        content: "v1",
        updatedAt: 1,
      }),
    );
    await Effect.runPromise(
      repo.upsert({
        botId,
        path: "bot-1/notes/topic.md",
        kind: "notes",
        content: "v2",
        updatedAt: 2,
      }),
    );
    const rows = db.prepare("SELECT COUNT(*) AS n FROM file_index").get() as { n: number };
    expect(rows.n).toBe(1);
    const contentRow = db
      .prepare("SELECT content FROM file_index WHERE path = ?")
      .get("bot-1/notes/topic.md") as { content: string };
    expect(contentRow.content).toBe("v2");
    temp.close(db);
  });

  it("removeByBot clears only that bot's entries", async () => {
    const db = await temp.open();
    const repo = createSqliteFileIndexRepository(db);
    const upsert = (botId: string, path: string) =>
      Effect.runPromise(
        repo.upsert({
          botId: asBotId(botId),
          path,
          kind: "notes",
          content: "x",
          updatedAt: 1,
        }),
      );
    await upsert("bot-1", "bot-1/notes/a.md");
    await upsert("bot-1", "bot-1/logs/b.md");
    await upsert("bot-2", "bot-2/notes/c.md");
    const removed = await Effect.runPromise(repo.removeByBot(asBotId("bot-1")));
    expect(removed).toBe(2);
    const hits = await Effect.runPromise(repo.search("x"));
    expect(hits).toHaveLength(1);
    expect(String(hits[0]?.botId)).toBe("bot-2");
    temp.close(db);
  });

  it("removes a path and prunes everything under a deleted directory", async () => {
    const db = await temp.open();
    const repo = createSqliteFileIndexRepository(db);
    const botId = asBotId("bot-1");
    const seed = (path: string): void => {
      void db
        .prepare(
          "INSERT INTO file_index (bot_id, path, kind, content, updated_at) VALUES (?, ?, 'notes', ?, 1)",
        )
        .run(botId, path, "x");
    };
    seed("bot-1/notes/a.md");
    seed("bot-1/notes/sub/b.md");
    seed("bot-1/memory/m.md");
    expect(await Effect.runPromise(repo.remove(botId, "bot-1/notes/a.md"))).toBeUndefined();
    const pruned = await Effect.runPromise(repo.removeUnderPrefix(botId, "bot-1/notes/sub"));
    expect(pruned).toBe(1);
    const sib = db
      .prepare("SELECT COUNT(*) AS n FROM file_index WHERE path = ?")
      .get("bot-1/notes/a.md") as { n: number };
    expect(sib.n).toBe(0);
    const kept = db
      .prepare("SELECT COUNT(*) AS n FROM file_index WHERE path = ?")
      .get("bot-1/memory/m.md") as { n: number };
    expect(kept.n).toBe(1);
    temp.close(db);
  });

  it("searches content with optional bot scoping", async () => {
    const db = await temp.open();
    const repo = createSqliteFileIndexRepository(db);
    await Effect.runPromise(
      repo.upsert({
        botId: asBotId("bot-1"),
        path: "bot-1/memory/facts.md",
        kind: "memory",
        content: "likes coffee",
        updatedAt: 1,
      }),
    );
    await Effect.runPromise(
      repo.upsert({
        botId: asBotId("bot-2"),
        path: "bot-2/memory/facts.md",
        kind: "memory",
        content: "likes tea",
        updatedAt: 1,
      }),
    );
    const all = await Effect.runPromise(repo.search("likes"));
    expect(all).toHaveLength(2);
    const scoped = await Effect.runPromise(repo.search("likes", asBotId("bot-2")));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.botId).toBe("bot-2" as BotId);
    const miss = await Effect.runPromise(repo.search("cappuccino"));
    expect(miss).toEqual([]);
    temp.close(db);
  });
});
