import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { asActivityId } from "@bebots/domain";
import type { ActivityEvent } from "@bebots/domain";
import { createSqliteActivityRepository } from "./sqlite-activity-repository.js";
import { withTempDatabase } from "./test-helpers.js";

describe("SqliteActivityRepository.deleteByEntityIds", () => {
  const temp = withTempDatabase();

  it("removes only events of the given entity type and ids", async () => {
    const db = await temp.open();
    const repo = createSqliteActivityRepository(db);
    const event = (id: string, entityType: string, entityId: string): ActivityEvent => ({
      id: asActivityId(id),
      type: "event",
      entityType,
      entityId,
      actorId: null,
      payload: null,
      createdAt: 1,
    });
    await Effect.runPromise(repo.create(event("a-1", "bot", "bot-1")));
    await Effect.runPromise(repo.create(event("a-2", "bot", "bot-2")));
    await Effect.runPromise(repo.create(event("a-3", "conversation", "conv-1")));
    await Effect.runPromise(repo.create(event("a-4", "conversation", "conv-2")));

    // Empty id list deletes nothing (and does not error).
    expect(await Effect.runPromise(repo.deleteByEntityIds("bot", []))).toBe(0);

    const removed = await Effect.runPromise(repo.deleteByEntityIds("bot", ["bot-1"]));
    expect(removed).toBe(1);
    const remaining = await Effect.runPromise(repo.findAll());
    expect(remaining.map((e) => e.id).sort()).toEqual(
      ["a-2", "a-3", "a-4"].map(asActivityId).sort(),
    );

    // Same entity id under a different entity type survives (type-scoped).
    const removed2 = await Effect.runPromise(
      repo.deleteByEntityIds("conversation", ["conv-1", "conv-2"]),
    );
    expect(removed2).toBe(2);
    const final = await Effect.runPromise(repo.findAll());
    expect(final.map((e) => e.id)).toEqual([asActivityId("a-2")]);
    temp.close(db);
  });
});
