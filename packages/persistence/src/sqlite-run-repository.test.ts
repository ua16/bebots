import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { asBotId, asRunId } from "@bebots/domain";
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
});
