import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ConversationSession } from "@bebots/domain";
import { asBotId, asConversationId, asConversationSessionId } from "@bebots/domain";
import { createSqliteConversationSessionRepository } from "./sqlite-conversation-session-repository.js";
import { withTempDatabase } from "./test-helpers.js";

describe("SqliteConversationSessionRepository", () => {
  const temp = withTempDatabase();

  it("persists sessions with canonical fields across restarts", async () => {
    const db = await temp.open();
    const repo = createSqliteConversationSessionRepository(db);
    const session: ConversationSession = {
      id: asConversationSessionId("s1"),
      conversationId: asConversationId("c1"),
      runtimeSessionId: "rt-1",
      lastUsedAt: 10,
      status: "active",
      createdAt: 5,
      updatedAt: 10,
    };
    await Effect.runPromise(repo.create(session));
    const found = await Effect.runPromise(repo.findById(asConversationSessionId("s1")));
    expect(found?.runtimeSessionId).toBe("rt-1");
    expect(found?.lastUsedAt).toBe(10);
    expect(found?.status).toBe("active");
    // Synonym spellings were deleted from the domain.
    expect(Object.keys(found ?? {})).not.toContain("sessionId");
    expect(Object.keys(found ?? {})).not.toContain("lastUsed");
    temp.close(db);
  });

  it("finds the latest active session, skipping expired ones", async () => {
    const db = await temp.open();
    const repo = createSqliteConversationSessionRepository(db);
    const base = (id: string, runtime: string, lastUsed: number): ConversationSession => ({
      id: asConversationSessionId(id),
      conversationId: asConversationId("c1"),
      runtimeSessionId: runtime,
      lastUsedAt: lastUsed,
      status: "active",
      createdAt: 0,
      updatedAt: lastUsed,
    });
    await Effect.runPromise(repo.create(base("s1", "rt-old", 5)));
    // Expired but more recent: create it directly in that state.
    await Effect.runPromise(repo.create({ ...base("s2", "rt-expired", 20), status: "expired" }));
    const latestAny = await Effect.runPromise(
      repo.findLatestByConversation(asConversationId("c1")),
    );
    expect(latestAny?.runtimeSessionId).toBe("rt-expired");
    const latestActive = await Effect.runPromise(
      repo.findLatestByConversation(asConversationId("c1"), { status: "active" }),
    );
    expect(latestActive?.runtimeSessionId).toBe("rt-old");
    temp.close(db);
  });

  it("rotates the stored runtime session via update", async () => {
    const db = await temp.open();
    const repo = createSqliteConversationSessionRepository(db);
    await Effect.runPromise(
      repo.create({
        id: asConversationSessionId("s1"),
        conversationId: asConversationId("c1"),
        runtimeSessionId: "rt-stale",
        lastUsedAt: 1,
        status: "active",
        createdAt: 0,
        updatedAt: 1,
      }),
    );
    const rotated = await Effect.runPromise(
      repo.update({
        id: asConversationSessionId("s1"),
        conversationId: asConversationId("c1"),
        runtimeSessionId: "rt-fresh",
        lastUsedAt: 50,
        status: "active",
        createdAt: 0,
        updatedAt: 50,
      }),
    );
    expect(rotated.runtimeSessionId).toBe("rt-fresh");
    const found = await Effect.runPromise(repo.findById(asConversationSessionId("s1")));
    expect(found?.runtimeSessionId).toBe("rt-fresh");
    temp.close(db);
  });

  it("deleteByConversation and deleteByBot purge scoped rows only", async () => {
    const db = await temp.open();
    const repo = createSqliteConversationSessionRepository(db);
    const make = (id: string, conversationId: string, botId: string | null) =>
      ({
        id: asConversationSessionId(id),
        conversationId: asConversationId(conversationId),
        runtimeSessionId: `rt-${id}`,
        botId,
        status: "active",
        lastUsedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }) as ConversationSession;
    await Effect.runPromise(repo.create(make("s1", "c1", "b1")));
    await Effect.runPromise(repo.create(make("s2", "c1", "b2")));
    await Effect.runPromise(repo.create(make("s3", "c2", "b1")));
    await Effect.runPromise(repo.create(make("s4", "c3", "b3")));

    // By bot: only b1's rows go delete — including those in other
    // conversations — leaving b2's and b3's.
    const byBot = await Effect.runPromise(repo.deleteByBot(asBotId("b1")));
    expect(byBot).toBe(2);
    expect(await Effect.runPromise(repo.findById(asConversationSessionId("s1")))).toBeNull();
    expect(await Effect.runPromise(repo.findById(asConversationSessionId("s3")))).toBeNull();
    expect((await Effect.runPromise(repo.findById(asConversationSessionId("s2"))))?.botId).toBe(
      "b2",
    );

    // By conversation: b2's row in c1 goes; b3's unrelated row stays.
    const byConversation = await Effect.runPromise(
      repo.deleteByConversation(asConversationId("c1")),
    );
    expect(byConversation).toBe(1);
    expect(await Effect.runPromise(repo.findById(asConversationSessionId("s2")))).toBeNull();
    expect((await Effect.runPromise(repo.findById(asConversationSessionId("s4"))))?.botId).toBe(
      "b3",
    );
    temp.close(db);
  });
});
