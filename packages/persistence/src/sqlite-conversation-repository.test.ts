import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { asConversationId } from "@bebots/domain";
import { createSqliteConversationRepository } from "./sqlite-conversation-repository.js";
import { NotFoundError } from "@bebots/application";
import type { Conversation } from "@bebots/domain";
import { withTempDatabase } from "./test-helpers.js";

describe("SqliteConversationRepository", () => {
  const temp = withTempDatabase();

  it("persists conversations across restarts", async () => {
    const db = await temp.open();
    const repo = createSqliteConversationRepository(db);
    const conversation: Conversation = {
      id: asConversationId("c1"),
      kind: "direct",
      title: "Hello",
      participants: ["b1", "human"],
      createdAt: 10,
      updatedAt: 10,
    };
    await Effect.runPromise(repo.create(conversation));
    // Persist sql.js's in-memory pages before reopening.
    const persisted = await Effect.runPromise(repo.findById(asConversationId("c1")));
    expect(persisted?.participants).toEqual(["b1", "human"]);
    temp.close(db);
  });

  it("filters findByKind and participant", async () => {
    const db = await temp.open();
    const repo = createSqliteConversationRepository(db);
    await Effect.runPromise(
      repo.create({
        id: asConversationId("c1"),
        kind: "direct",
        title: "a",
        participants: ["b1"],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await Effect.runPromise(
      repo.create({
        id: asConversationId("c2"),
        kind: "team",
        title: "b",
        participants: ["b2"],
        createdAt: 2,
        updatedAt: 2,
      }),
    );
    const direct = await Effect.runPromise(repo.findAll({ kind: "direct" }));
    expect(direct.map((c) => c.id)).toEqual([asConversationId("c1")]);
    const withB2 = await Effect.runPromise(repo.findAll({ participant: "b2" }));
    expect(withB2.map((c) => c.id)).toEqual([asConversationId("c2")]);
    temp.close(db);
  });

  it("updates and fails typed NotFoundError", async () => {
    const db = await temp.open();
    const repo = createSqliteConversationRepository(db);
    await Effect.runPromise(
      repo.create({
        id: asConversationId("c1"),
        kind: "direct",
        title: "before",
        participants: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const updated = await Effect.runPromise(
      repo.update({
        id: asConversationId("c1"),
        kind: "direct",
        title: "after",
        participants: ["b1"],
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    expect(updated.title).toBe("after");
    expect(updated.participants).toEqual(["b1"]);
    const exit = await Effect.runPromiseExit(
      repo.update({
        id: asConversationId("missing"),
        kind: "direct",
        title: "x",
        participants: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(NotFoundError);
    }
    temp.close(db);
  });
});
