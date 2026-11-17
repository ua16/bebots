import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { asBotId, asTaskId } from "@bebots/domain";
import type { Task } from "@bebots/domain";
import { createSqliteTaskRepository } from "./sqlite-task-repository.js";
import { withTempDatabase } from "./test-helpers.js";

describe("SqliteTaskRepository.deleteByBot", () => {
  const temp = withTempDatabase();

  it("removes tasks where the bot is assignee or requester, nothing else", async () => {
    const db = await temp.open();
    const repo = createSqliteTaskRepository(db);
    const make = (id: string, requester: string | null, assignee: string): Task =>
      ({
        id: asTaskId(id),
        requester,
        assignee,
        description: "d",
        inputRefs: [],
        priority: 0,
        status: "queued",
        depth: 0,
        createdAt: 1,
        updatedAt: 1,
      }) as Task;
    await Effect.runPromise(repo.create(make("t-assignee", null, "bot-1")));
    await Effect.runPromise(repo.create(make("t-requester", "bot-1", "bot-2")));
    await Effect.runPromise(repo.create(make("t-other", "bot-3", "bot-2")));
    await Effect.runPromise(repo.create(make("t-unsync", null, "bot-3")));

    const removed = await Effect.runPromise(repo.deleteByBot(asBotId("bot-1")));
    expect(removed).toBe(2);
    expect(await Effect.runPromise(repo.findById(asTaskId("t-assignee")))).toBeNull();
    expect(await Effect.runPromise(repo.findById(asTaskId("t-requester")))).toBeNull();
    expect((await Effect.runPromise(repo.findById(asTaskId("t-other"))))?.id).toBe(
      asTaskId("t-other"),
    );
    // Repeat is a no-op (no rows left for this bot).
    expect(await Effect.runPromise(repo.deleteByBot(asBotId("bot-1")))).toBe(0);
    temp.close(db);
  });
});
