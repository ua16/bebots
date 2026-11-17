// Deletion integration suite: bot and conversation deletion over the live
// HTTP API of a booted headless app (electron mocked, runtime scripted).
// Verifies the full cascade — conversations, messages, sessions, runs,
// schedules, activity — leaves no orphans and keeps every other bot's data
// intact. The service-level ordering invariants are covered by
// bot-deletion-service.test.ts; this suite proves the wiring end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, bootTestApp, createBot, type BootedApp } from "./test-boot";
import { scripted } from "./scripted-runtime";

vi.mock("@bebots/runtime-opencode", () => import("./scripted-runtime"));

type RunShape = { id: string; status: string; triggerType?: string };
type MessageShape = { id: string; senderType: string; content: string };
type ConversationShape = { id: string; title: string; participants: string[] };
type ScheduleShape = { id: string; botId: string; prompt: string };
type ActivityShape = { id: string; type: string; entityType: string; entityId: string };

async function pollUntil<T>(step: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("pollUntil: deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function awaitRun(
  app: BootedApp,
  runId: string,
  status: "succeeded" | "failed",
): Promise<RunShape> {
  return pollUntil(async () => {
    const res = await api(app, "GET", `/api/v1/runs/${runId}`);
    const run = res.body as RunShape;
    if (run.status === status) return run;
    if (run.status !== "queued" && run.status !== "running") {
      throw new Error(`run ${runId}: expected ${status}, saw ${run.status}`);
    }
    return undefined;
  }, 20_000);
}

/** The bot reply may land after the run is already terminal; poll for it. */
async function awaitBotReply(app: BootedApp, conversationId: string, content: string) {
  return pollUntil(async () => {
    const res = await api(app, "GET", `/api/v1/conversations/${conversationId}/messages`);
    const messages = res.body as MessageShape[];
    return messages.find((m) => m.senderType === "bot" && m.content === content);
  }, 20_000);
}

describe("deletion over the live HTTP API", () => {
  let app: BootedApp;

  beforeEach(async () => {
    scripted.reset();
    app = await bootTestApp({ tmpPrefix: "bebots-deletion-" });
  });

  afterEach(() => {
    app?.appHandlers["before-quit"]?.();
    vi.restoreAllMocks();
    app?.dispose();
  });

  it("deleting a bot wipes its threads (group chats included), runs, schedules and activity — others survive", async () => {
    // Three bots: the victim, a group-chat co-tenant, and a bystander.
    const victim = await createBot(app, "Victim");
    const coTenant = await createBot(app, "CoTenant");
    const bystander = await createBot(app, "Bystander");

    // Group thread with both bots; each message starts one scripted run.
    scripted.script({ summary: "group answer victim" }, { summary: "group answer co" });
    const groupRes = await api(app, "POST", "/api/v1/conversations", {
      title: "group thread",
      participants: [victim.id, coTenant.id],
    });
    expect(groupRes.status).toBe(201);
    const group = groupRes.body as ConversationShape;

    const groupMsg = await api(app, "POST", `/api/v1/conversations/${group.id}/messages`, {
      content: "hello group",
    });
    expect(groupMsg.status).toBe(201);
    const groupRunId = (groupMsg.body as { runId: string | null }).runId;
    expect(groupRunId).not.toBeNull();
    await awaitRun(app, groupRunId as string, "succeeded");
    expect(await awaitBotReply(app, group.id, "group answer victim")).toBeDefined();

    // The bystander's own private thread with a manual run that must survive.
    scripted.script({ summary: "bystander manual" });
    const privateRes = await api(app, "POST", "/api/v1/conversations", {
      title: "bystander private",
      participants: [bystander.id],
    });
    expect(privateRes.status).toBe(201);
    const bystanderPrivate = privateRes.body as ConversationShape;
    const manualRes = await api(app, "POST", `/api/v1/bots/${bystander.id}/runs`, {
      prompt: "standalone work",
    });
    expect(manualRes.status).toBe(201);
    const manualRun = await awaitRun(app, (manualRes.body as RunShape).id, "succeeded");
    expect(manualRun.status).toBe("succeeded");

    // Schedules: the victim owns one; the bystander owns another. Neither
    // fires inside the test window (60s domain minimum on intervals).
    const victimScheduleRes = await api(app, "POST", "/api/v1/schedules", {
      botId: victim.id,
      prompt: "victim chore",
      trigger: { kind: "interval", everyMs: 60_000 },
    });
    expect(victimScheduleRes.status).toBe(201);
    const victimSchedule = victimScheduleRes.body as ScheduleShape;

    const bystanderScheduleRes = await api(app, "POST", "/api/v1/schedules", {
      botId: bystander.id,
      prompt: "bystander chore",
      trigger: { kind: "interval", everyMs: 60_000 },
    });
    expect(bystanderScheduleRes.status).toBe(201);
    const bystanderSchedule = bystanderScheduleRes.body as ScheduleShape;

    // Nothing has fired yet, so the activity feed starts empty (schedules
    // only record fire/miss/failure events, and intervals never fire in this
    // test's window).
    const activityBefore = (await api(app, "GET", "/api/v1/activity?limit=100"))
      .body as ActivityShape[];
    expect(activityBefore).toEqual([]);

    // --- Delete the victim --------------------------------------------------
    const del = await api(app, "DELETE", `/api/v1/bots/${victim.id}`);
    expect(del.status).toBe(204);

    // The bot itself is gone.
    expect((await api(app, "GET", `/api/v1/bots/${victim.id}`)).status).toBe(404);

    // Its threads (the group chat included) are gone, and with them their
    // messages and session records (the list endpoints return empty for a
    // purged thread instead of 404 — the children no longer exist).
    expect((await api(app, "GET", `/api/v1/conversations/${group.id}`)).status).toBe(404);
    const groupMessages = (await api(app, "GET", `/api/v1/conversations/${group.id}/messages`))
      .body as MessageShape[];
    expect(groupMessages).toEqual([]);
    const groupSessions = (await api(app, "GET", `/api/v1/conversations/${group.id}/sessions`))
      .body as { id: string }[];
    expect(groupSessions).toEqual([]);

    // The in-flight conversation run bound to the deleted thread is gone.
    expect((await api(app, "GET", `/api/v1/runs/${groupRunId}`)).status).toBe(404);

    // The victim's schedule is gone; the bystander's stays.
    expect((await api(app, "GET", `/api/v1/schedules/${victimSchedule.id}`)).status).toBe(404);
    const schedulesAfter = (await api(app, "GET", "/api/v1/schedules")).body as ScheduleShape[];
    expect(schedulesAfter.map((s) => s.id)).toEqual([bystanderSchedule.id]);

    // Activity no longer references the victim's entities — the only event
    // mentioning it is the deletion audit row.
    const activityAfter = (await api(app, "GET", "/api/v1/activity?limit=100"))
      .body as ActivityShape[];
    expect(
      activityAfter.map((e) => ({ type: e.type, entityType: e.entityType, entityId: e.entityId })),
    ).toEqual([{ type: "bot.deleted", entityType: "bot", entityId: victim.id }]);

    // --- Everyone else is untouched ------------------------------------------
    expect((await api(app, "GET", `/api/v1/bots/${coTenant.id}`)).status).toBe(200);
    expect((await api(app, "GET", `/api/v1/bots/${bystander.id}`)).status).toBe(200);
    expect((await api(app, "GET", `/api/v1/conversations/${bystanderPrivate.id}`)).status).toBe(
      200,
    );
    // The bystander's thread never received a message; it is still empty.
    const bystanderMessages = (
      await api(app, "GET", `/api/v1/conversations/${bystanderPrivate.id}/messages`)
    ).body as MessageShape[];
    expect(bystanderMessages).toEqual([]);
    expect((await api(app, "GET", `/api/v1/runs/${manualRun.id}`)).status).toBe(200);
  });

  it("returns 404 and leaves data untouched when the bot does not exist", async () => {
    const bot = await createBot(app, "Lives");
    const before = (await api(app, "GET", "/api/v1/bots")).body as { id: string }[];
    const res = await api(app, "DELETE", "/api/v1/bots/does-not-exist");
    expect(res.status).toBe(404);
    const after = (await api(app, "GET", "/api/v1/bots")).body as { id: string }[];
    expect(after.map((b) => b.id)).toEqual(before.map((b) => b.id));
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(bot.id);
  });

  it("deleting a conversation purges its messages, sessions and runs — its bot survives", async () => {
    scripted.reset();
    const bot = await createBot(app, "Chatter");

    // Two threads for the same bot; the manual run happens outside any thread.
    scripted.script({ summary: "thread one reply" }, { summary: "manual reply" });
    const convRes = await api(app, "POST", "/api/v1/conversations", {
      title: "doomed thread",
      participants: [bot.id],
    });
    expect(convRes.status).toBe(201);
    const conv = convRes.body as ConversationShape;
    const msgRes = await api(app, "POST", `/api/v1/conversations/${conv.id}/messages`, {
      content: "say something",
    });
    expect(msgRes.status).toBe(201);
    const convRunId = (msgRes.body as { runId: string | null }).runId as string;
    await awaitRun(app, convRunId, "succeeded");
    expect(await awaitBotReply(app, conv.id, "thread one reply")).toBeDefined();

    const survivorRes = await api(app, "POST", "/api/v1/conversations", {
      title: "kept thread",
      participants: [bot.id],
    });
    const survivor = survivorRes.body as ConversationShape;

    const manualRes = await api(app, "POST", `/api/v1/bots/${bot.id}/runs`, {
      prompt: "manual work",
    });
    const manualRunId = (manualRes.body as RunShape).id;
    await awaitRun(app, manualRunId, "succeeded");

    // Sessions exist for the doomed thread before deletion.
    const sessionsBefore = (await api(app, "GET", `/api/v1/conversations/${conv.id}/sessions`))
      .body as { id: string }[];
    expect(sessionsBefore.length).toBeGreaterThan(0);

    // --- Delete the conversation ---------------------------------------------
    const del = await api(app, "DELETE", `/api/v1/conversations/${conv.id}`);
    expect(del.status).toBe(204);

    expect((await api(app, "GET", `/api/v1/conversations/${conv.id}`)).status).toBe(404);
    // Messages and session records are purged: the list endpoints come back
    // empty for the deleted thread.
    const convMessages = (await api(app, "GET", `/api/v1/conversations/${conv.id}/messages`))
      .body as MessageShape[];
    expect(convMessages).toEqual([]);
    const convSessions = (await api(app, "GET", `/api/v1/conversations/${conv.id}/sessions`))
      .body as { id: string }[];
    expect(convSessions).toEqual([]);
    // Its run rows are gone too.
    expect((await api(app, "GET", `/api/v1/runs/${convRunId}`)).status).toBe(404);
    // Posting into the deleted thread fails typed.
    const lateMsg = await api(app, "POST", `/api/v1/conversations/${conv.id}/messages`, {
      content: "anyone there?",
    });
    expect(lateMsg.status).toBe(404);

    // The bot, its other thread, and its out-of-thread run all survive.
    expect((await api(app, "GET", `/api/v1/bots/${bot.id}`)).status).toBe(200);
    expect((await api(app, "GET", `/api/v1/conversations/${survivor.id}`)).status).toBe(200);
    expect((await api(app, "GET", `/api/v1/runs/${manualRunId}`)).status).toBe(200);
    const botRuns = (await api(app, "GET", `/api/v1/bots/${bot.id}/runs`)).body as RunShape[];
    expect(botRuns.map((r) => r.id)).toEqual([manualRunId]);

    // Deleting it again fails typed.
    const repeat = await api(app, "DELETE", `/api/v1/conversations/${conv.id}`);
    expect(repeat.status).toBe(404);
  });
});
