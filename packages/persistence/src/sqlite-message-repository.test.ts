import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { asConversationId, asMessageId } from "@bebots/domain";
import { createSqliteMessageRepository } from "./sqlite-message-repository.js";
import { NotFoundError } from "@bebots/application";
import type { Message } from "@bebots/domain";
import { withTempDatabase } from "./test-helpers.js";

describe("SqliteMessageRepository", () => {
  const temp = withTempDatabase();

  it("persists canonical sender fields across restarts", async () => {
    const db = await temp.open();
    const repo = createSqliteMessageRepository(db);
    const message: Message = {
      id: asMessageId("m1"),
      conversationId: asConversationId("c1"),
      senderType: "bot",
      senderId: "b1",
      content: "greetings",
      replyTo: asMessageId("m0"),
      deliveryState: "delivered",
      createdAt: 10,
    };
    await Effect.runPromise(repo.create(message));
    const found = await Effect.runPromise(repo.findById(asMessageId("m1")));
    expect(found?.senderType).toBe("bot");
    expect(found?.senderId).toBe("b1");
    expect(found?.deliveryState).toBe("delivered");
    expect(found?.replyTo).toBe(asMessageId("m0"));
    // Exactly one last-used/created spelling survives; synonyms are gone.
    expect(Object.keys(found ?? {})).not.toContain("timestamp");
    expect(Object.keys(found ?? {})).not.toContain("deliveryStatus");
    temp.close(db);
  });

  it("orders by conversation and paginates", async () => {
    const db = await temp.open();
    const repo = createSqliteMessageRepository(db);
    const make = (id: string, at: number): Message => ({
      id: asMessageId(id),
      conversationId: asConversationId("c1"),
      senderType: "human",
      content: id,
      deliveryState: "delivered",
      createdAt: at,
    });
    await Effect.runPromise(repo.create(make("m1", 1)));
    await Effect.runPromise(repo.create(make("m2", 2)));
    await Effect.runPromise(
      repo.create({ ...make("m3", 3), conversationId: asConversationId("c2") }),
    );
    const thread = await Effect.runPromise(repo.findByConversation(asConversationId("c1")));
    expect(thread.map((m) => m.id)).toEqual([asMessageId("m1"), asMessageId("m2")]);
    const paged = await Effect.runPromise(
      repo.findByConversation(asConversationId("c1"), { limit: 1 }),
    );
    expect(paged.map((m) => m.id)).toEqual([asMessageId("m1")]);
    temp.close(db);
  });

  it("deleteByConversation removes only that conversation's messages", async () => {
    const db = await temp.open();
    const repo = createSqliteMessageRepository(db);
    const make = (id: string, conversationId: string): Message => ({
      id: asMessageId(id),
      conversationId: asConversationId(conversationId),
      senderType: "human",
      content: id,
      deliveryState: "delivered",
      createdAt: 1,
    });
    await Effect.runPromise(repo.create(make("m1", "c1")));
    await Effect.runPromise(repo.create(make("m2", "c1")));
    await Effect.runPromise(repo.create(make("m3", "c2")));
    const removed = await Effect.runPromise(repo.deleteByConversation(asConversationId("c1")));
    expect(removed).toBe(2);
    expect(await Effect.runPromise(repo.findById(asMessageId("m1")))).toBeNull();
    expect(await Effect.runPromise(repo.findById(asMessageId("m2")))).toBeNull();
    expect((await Effect.runPromise(repo.findById(asMessageId("m3"))))?.id).toBe(asMessageId("m3"));
    // Deleting an empty conversation succeeds with zero rows.
    const again = await Effect.runPromise(repo.deleteByConversation(asConversationId("c1")));
    expect(again).toBe(0);
    temp.close(db);
  });

  it("updates and fails typed NotFoundError", async () => {
    const db = await temp.open();
    const repo = createSqliteMessageRepository(db);
    const base: Message = {
      id: asMessageId("m1"),
      conversationId: asConversationId("c1"),
      senderType: "human",
      content: "before",
      deliveryState: "pending",
      createdAt: 1,
    };
    await Effect.runPromise(repo.create(base));
    const updated = await Effect.runPromise(
      repo.update({ ...base, content: "after", deliveryState: "delivered" }),
    );
    expect(updated.content).toBe("after");
    const found = await Effect.runPromise(repo.findById(asMessageId("m1")));
    expect(found?.deliveryState).toBe("delivered");
    const exit = await Effect.runPromiseExit(repo.update({ ...base, id: asMessageId("nope") }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(NotFoundError);
    }
    temp.close(db);
  });
});
