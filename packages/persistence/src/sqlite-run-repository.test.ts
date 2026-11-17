import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { asBotId, asConversationId, asRunId } from "@bebots/domain";
import { openDatabase, migrate, createSqliteRunRepository } from "./index";

describe("SqliteRunRepository", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bebots-"));
    dbPath = join(dir, "app.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates and persists runs", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteRunRepository(db);
    const run = {
      id: asRunId("run-1"),
      botId: asBotId("bot-1"),
      triggerType: "manual" as const,
      prompt: "hi",
      status: "queued" as const,
      timeoutMs: 1000,
      createdAt: 10,
      updatedAt: 10,
    };
    await Effect.runPromise(repo.create(run));
    db.close();

    const db2 = await openDatabase(dbPath);
    migrate(db2);
    const repo2 = createSqliteRunRepository(db2);
    const found = await Effect.runPromise(repo2.findById(asRunId("run-1")));
    expect(found?.prompt).toBe("hi");
    const missing = await Effect.runPromise(repo2.findById(asRunId("missing")));
    expect(missing).toBeNull();
    db2.close();
  });

  it("filters by botId and status", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteRunRepository(db);
    const r1 = {
      id: asRunId("r1"),
      botId: asBotId("b1"),
      triggerType: "manual" as const,
      prompt: "a",
      status: "queued" as const,
      timeoutMs: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const r2 = {
      id: asRunId("r2"),
      botId: asBotId("b2"),
      triggerType: "api" as const,
      prompt: "b",
      status: "succeeded" as const,
      timeoutMs: 1,
      createdAt: 2,
      updatedAt: 2,
    };
    await Effect.runPromise(repo.create(r1));
    await Effect.runPromise(repo.create(r2));
    const byBot = await Effect.runPromise(repo.findAll({ botId: asBotId("b1") }));
    expect(byBot).toHaveLength(1);
    const byStatus = await Effect.runPromise(repo.findAll({ status: "succeeded" }));
    expect(byStatus).toHaveLength(1);
    const limited = await Effect.runPromise(repo.findAll({ limit: 1 }));
    expect(limited).toHaveLength(1);
    db.close();
  });

  it("updates and throws NotFoundError", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteRunRepository(db);
    const run = {
      id: asRunId("r1"),
      botId: asBotId("b1"),
      triggerType: "manual" as const,
      prompt: "a",
      status: "queued" as const,
      timeoutMs: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    await Effect.runPromise(repo.create(run));
    const updated = { ...run, status: "running" as const, updatedAt: 2 };
    const res = await Effect.runPromise(repo.update(updated));
    expect(res.status).toBe("running");
    await expect(
      Effect.runPromise(repo.update({ ...run, id: asRunId("nope"), status: "running" as const })),
    ).rejects.toThrow();
    db.close();
  });

  it("appends and lists events", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteRunRepository(db);
    const run = {
      id: asRunId("r1"),
      botId: asBotId("b1"),
      triggerType: "manual" as const,
      prompt: "a",
      status: "queued" as const,
      timeoutMs: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    await Effect.runPromise(repo.create(run));
    await Effect.runPromise(repo.appendEvent(asRunId("r1"), { _tag: "started", at: 1 }));
    const evs = await Effect.runPromise(repo.listEvents(asRunId("r1")));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.tag).toBe("started");
    db.close();
  });

  it("filters by conversationId in findAll", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteRunRepository(db);
    const mk = (id: string, botId: string, conversationId?: string) => ({
      id: asRunId(id),
      botId: asBotId(botId),
      triggerType: "manual" as const,
      prompt: "p",
      status: "succeeded" as const,
      timeoutMs: 1,
      ...(conversationId ? { conversationId: asConversationId(conversationId) } : {}),
      createdAt: 1,
      updatedAt: 1,
    });
    await Effect.runPromise(repo.create(mk("r1", "b1", "conv-1")));
    await Effect.runPromise(repo.create(mk("r2", "b2", "conv-1")));
    await Effect.runPromise(repo.create(mk("r3", "b3")));
    const inConv = await Effect.runPromise(
      repo.findAll({ conversationId: asConversationId("conv-1") }),
    );
    expect(inConv.map((r) => String(r.id)).sort()).toEqual(["r1", "r2"]);
    const both = await Effect.runPromise(
      repo.findAll({ conversationId: asConversationId("conv-1"), status: "queued" }),
    );
    expect(both).toHaveLength(0);
    db.close();
  });

  it("deleteByBot removes the bot's runs and their events only", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteRunRepository(db);
    const mk = (id: string, botId: string) => ({
      id: asRunId(id),
      botId: asBotId(botId),
      triggerType: "manual" as const,
      prompt: "p",
      status: "succeeded" as const,
      timeoutMs: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await Effect.runPromise(repo.create(mk("r1", "b1")));
    await Effect.runPromise(repo.create(mk("r2", "b1")));
    await Effect.runPromise(repo.create(mk("r3", "b2")));
    await Effect.runPromise(repo.appendEvent(asRunId("r1"), { _tag: "started", at: 1 }));
    await Effect.runPromise(repo.appendEvent(asRunId("r3"), { _tag: "started", at: 2 }));

    const removed = await Effect.runPromise(repo.deleteByBot(asBotId("b1")));
    expect(removed).toBe(2);
    expect(await Effect.runPromise(repo.findById(asRunId("r1")))).toBeNull();
    expect(await Effect.runPromise(repo.findById(asRunId("r2")))).toBeNull();
    // The other bot's run and its events survive.
    expect((await Effect.runPromise(repo.findById(asRunId("r3"))))?.id).toBe(asRunId("r3"));
    const r3Events = await Effect.runPromise(repo.listEvents(asRunId("r3")));
    expect(r3Events).toHaveLength(1);
    // The deleted runs' events are gone too: r1's events can no longer be listed
    // (no run row), and sqlite has no run_events row for them.
    const leftoverEvents = db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as {
      n: number;
    };
    expect(leftoverEvents.n).toBe(1);

    // Deleting again is a no-op, not an error.
    const again = await Effect.runPromise(repo.deleteByBot(asBotId("b1")));
    expect(again).toBe(0);
    db.close();
  });

  it("deleteByConversation removes every participant's runs and their events", async () => {
    const db = await openDatabase(dbPath);
    migrate(db);
    const repo = createSqliteRunRepository(db);
    const mk = (id: string, botId: string, conversationId?: string) => ({
      id: asRunId(id),
      botId: asBotId(botId),
      triggerType: "message" as const,
      prompt: "p",
      status: "succeeded" as const,
      timeoutMs: 1,
      ...(conversationId ? { conversationId: asConversationId(conversationId) } : {}),
      createdAt: 1,
      updatedAt: 1,
    });
    await Effect.runPromise(repo.create(mk("r1", "b1", "conv-1")));
    await Effect.runPromise(repo.create(mk("r2", "b2", "conv-1")));
    await Effect.runPromise(repo.create(mk("r3", "b2", "conv-2")));
    await Effect.runPromise(repo.appendEvent(asRunId("r1"), { _tag: "started", at: 1 }));
    await Effect.runPromise(repo.appendEvent(asRunId("r2"), { _tag: "started", at: 2 }));
    await Effect.runPromise(repo.appendEvent(asRunId("r3"), { _tag: "started", at: 3 }));

    const removed = await Effect.runPromise(repo.deleteByConversation(asConversationId("conv-1")));
    expect(removed).toBe(2);
    expect(await Effect.runPromise(repo.findById(asRunId("r1")))).toBeNull();
    expect(await Effect.runPromise(repo.findById(asRunId("r2")))).toBeNull();
    expect((await Effect.runPromise(repo.findById(asRunId("r3"))))?.id).toBe(asRunId("r3"));
    const leftoverEvents = db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as {
      n: number;
    };
    expect(leftoverEvents.n).toBe(1);
    db.close();
  });
});
