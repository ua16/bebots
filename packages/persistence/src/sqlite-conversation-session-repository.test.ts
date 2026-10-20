import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ConversationSession } from "@bebots/domain";
import { asConversationId, asConversationSessionId } from "@bebots/domain";
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
});
