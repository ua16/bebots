import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  asBotId,
  asConversationId,
  asRunId,
  asScheduleId,
  asScheduleOccurrenceId,
} from "@bebots/domain";
import type { Schedule } from "@bebots/domain";
import { openDatabase, migrate, createSqliteScheduleRepository } from "./index";
import type { SqliteDatabase } from "./database";

function makeSchedule(id: string, overrides?: Partial<Schedule>): Schedule {
  return {
    id: asScheduleId(id),
    botId: asBotId("bot-1"),
    prompt: "Run the weekly digest",
    trigger: { kind: "cron", expression: "0 9 * * 1", timezone: "UTC" },
    enabled: true,
    conversationId: null,
    createdBy: null,
    anchorAt: 1_000,
    nextRunAt: 2_000,
    lastRunAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as Schedule;
}

describe("SqliteScheduleRepository", () => {
  let dir: string;
  let db: SqliteDatabase;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bebots-"));
    db = await openDatabase(join(dir, "app.sqlite"));
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists schedules across connections and round-trips the trigger", async () => {
    const repo = createSqliteScheduleRepository(db);
    const schedule = makeSchedule("sched-1");
    await Effect.runPromise(repo.create(schedule));
    db.close();

    const db2 = await openDatabase(join(dir, "app.sqlite"));
    migrate(db2);
    const repo2 = createSqliteScheduleRepository(db2);
    const found = await Effect.runPromise(repo2.findById(asScheduleId("sched-1")));
    expect(found?.trigger).toEqual({ kind: "cron", expression: "0 9 * * 1", timezone: "UTC" });
    expect(found?.enabled).toBe(true);
    expect(found?.nextRunAt).toBe(2_000);
    db2.close();

    db = await openDatabase(join(dir, "app.sqlite"));
  });

  it("finds due schedules only", async () => {
    const repo = createSqliteScheduleRepository(db);
    await Effect.runPromise(repo.create(makeSchedule("due")));
    await Effect.runPromise(repo.create(makeSchedule("future", { nextRunAt: 50_000 })));
    await Effect.runPromise(repo.create(makeSchedule("disabled", { enabled: false })));
    const due = await Effect.runPromise(repo.findDue(10_000));
    expect(due.map((s) => String(s.id))).toEqual(["due"]);
  });

  it("createOccurrence is idempotent per (schedule, scheduledFor)", async () => {
    const repo = createSqliteScheduleRepository(db);
    const occurrence = {
      id: asScheduleOccurrenceId("occ-a"),
      scheduleId: asScheduleId("sched-1"),
      scheduledFor: 2_000,
      status: "pending" as const,
      runId: null,
      attempts: 0,
      error: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const first = await Effect.runPromise(repo.createOccurrence(occurrence));
    expect(String(first.id)).toBe("occ-a");
    // Different id, same slot: existing row wins, insert is ignored.
    const second = await Effect.runPromise(
      repo.createOccurrence({ ...occurrence, id: asScheduleOccurrenceId("occ-b") }),
    );
    expect(String(second.id)).toBe("occ-a");
  });

  it("updates occurrences and resolves them by run id", async () => {
    const repo = createSqliteScheduleRepository(db);
    const occurrenceA = {
      id: asScheduleOccurrenceId("occ-1"),
      scheduleId: asScheduleId("sched-1"),
      scheduledFor: 2_000,
      status: "pending" as const,
      runId: null,
      attempts: 0,
      error: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    await Effect.runPromise(repo.createOccurrence(occurrenceA));
    const enqueued = await Effect.runPromise(
      repo.updateOccurrence({
        ...occurrenceA,
        status: "enqueued",
        runId: asRunId("run-9"),
        attempts: 1,
        updatedAt: 2_000,
      }),
    );
    expect(enqueued.status).toBe("enqueued");
    const byRun = await Effect.runPromise(repo.findOccurrenceByRun(asRunId("run-9")));
    expect(String(byRun?.id)).toBe("occ-1");
  });

  it("listing occurrences orders newest first and deleting removes them", async () => {
    const repo = createSqliteScheduleRepository(db);
    const base = {
      scheduleId: asScheduleId("sched-1"),
      status: "succeeded" as const,
      runId: null,
      attempts: 0,
      error: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    await Effect.runPromise(
      repo.createOccurrence({ ...base, id: asScheduleOccurrenceId("o-old"), scheduledFor: 1_000 }),
    );
    await Effect.runPromise(
      repo.createOccurrence({ ...base, id: asScheduleOccurrenceId("o-new"), scheduledFor: 5_000 }),
    );
    const listed = await Effect.runPromise(repo.listOccurrences(asScheduleId("sched-1")));
    expect(listed.map((o) => o.scheduledFor)).toEqual([5_000, 1_000]);
    const removed = await Effect.runPromise(repo.deleteOccurrences(asScheduleId("sched-1")));
    expect(removed).toBe(2);
    expect(await Effect.runPromise(repo.listOccurrences(asScheduleId("sched-1")))).toEqual([]);
  });

  it("findAll filters by conversationId", async () => {
    const repo = createSqliteScheduleRepository(db);
    await Effect.runPromise(repo.create(makeSchedule("s-free", { conversationId: null })));
    await Effect.runPromise(
      repo.create(makeSchedule("s-bound", { conversationId: asConversationId("conv-1") })),
    );
    await Effect.runPromise(
      repo.create(makeSchedule("s-other", { conversationId: asConversationId("conv-2") })),
    );
    const bound = await Effect.runPromise(
      repo.findAll({ conversationId: asConversationId("conv-1") }),
    );
    expect(bound.map((s) => String(s.id))).toEqual(["s-bound"]);
    // Null conversation ids never match a concrete one.
    expect(
      (await Effect.runPromise(repo.findAll({ conversationId: asConversationId("missing") }))).map(
        (s) => String(s.id),
      ),
    ).toEqual([]);
    const free = await Effect.runPromise(repo.findAll());
    expect(free).toHaveLength(3);
  });
});
