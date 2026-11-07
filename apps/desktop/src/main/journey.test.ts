// Full-cycle integration suite: boots the main process headlessly (electron
// mocked, UI never initialized), scripts the runtime behind the AgentRuntime
// seam, and walks the user journey through the real HTTP API of a live
// server. Complements the per-endpoint contract suites and renderer tests;
// routes without a renderer affordance (run cancel, tasks, notes, activity)
// are out of scope.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@bebots/application";
import { api, bootTestApp, createBot, reboot, type BootedApp } from "./test-boot";
import { scripted } from "./scripted-runtime";

vi.mock("@bebots/runtime-opencode", () => import("./scripted-runtime"));

// Fast scheduler ticks so the one-shot schedule fires within the test.
const USER_ENV = {
  ELECTRON_RENDERER_URL: "http://localhost:5173",
  BEBOTS_SCHEDULE_TICK_MS: "150",
};

type RunShape = {
  id: string;
  status: string;
  sessionId?: string;
  exitCode?: number;
  summary?: string;
  error?: string;
};

type MessageShape = { id: string; senderType: string; content: string };

function recordedRequest<T>(requests: readonly T[], index: number): T {
  const request = requests[index];
  if (!request) throw new Error(`journey: run request ${index} was not recorded`);
  return request;
}

async function pollUntil<T>(step: () => Promise<T | undefined>, deadlineMs = 10_000): Promise<T> {
  const deadline = Date.now() + deadlineMs;
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
  });
}

/** The bot reply may land after the run is already terminal; poll for it. */
async function awaitBotReply(app: BootedApp, conversationId: string, content: string) {
  return pollUntil(async () => {
    const res = await api(app, "GET", `/api/v1/conversations/${conversationId}/messages`);
    const messages = res.body as MessageShape[];
    return messages.find((m) => m.senderType === "bot" && m.content === content);
  }, 20_000);
}

describe("user journey over the live HTTP API", () => {
  let app: BootedApp;

  beforeEach(async () => {
    scripted.reset();
    app = await bootTestApp({ tmpPrefix: "bebots-journey-", env: { ...USER_ENV } });
  });

  afterEach(() => {
    app?.appHandlers["before-quit"]?.();
    for (const key of Object.keys(USER_ENV)) delete process.env[key];
    vi.restoreAllMocks();
    app?.dispose();
  });

  it("bots, conversation, schedules, settings — then a restart keeps everything", async () => {
    // Pop order is deterministic: msg1, msg2, scheduled run, manual run,
    // manual failing run.
    scripted.script(
      { summary: "Reviewed 3 notes — 2 need follow-up" },
      { summary: "Short answer: yes, with caveats" },
      { summary: "You're set for the day", sessionPrefix: "sched" },
      {
        summary: "Prepped the daily brief",
        events: [{ _tag: "progress", message: "gathering notes" } as RuntimeEvent],
      },
      { summary: "boom", exitCode: 1 },
    );

    const bot = await createBot(app, "Nova");
    const renamed = await api(app, "PATCH", `/api/v1/bots/${bot.id}`, { name: "Nova Prime" });
    expect(renamed.status).toBe(200);
    expect((renamed.body as { name: string }).name).toBe("Nova Prime");

    const conversation = await api(app, "POST", "/api/v1/conversations", {
      title: "Daily standup",
      participants: [bot.id],
    });
    expect(conversation.status).toBe(201);
    const conv = conversation.body as { id: string; participants: string[] };
    expect(conv.participants).toContain(bot.id);

    const posted = await api(app, "POST", `/api/v1/conversations/${conv.id}/messages`, {
      content: "review my notes",
    });
    expect(posted.status).toBe(201);
    const first = posted.body as { message: MessageShape; runId: string | null };
    expect(first.message.senderType).toBe("human");
    expect(first.message.content).toBe("review my notes");
    expect(first.runId).not.toBeNull();

    const run1 = await awaitRun(app, first.runId as string, "succeeded");
    expect(run1.summary).toBe("Reviewed 3 notes — 2 need follow-up");
    expect(run1.sessionId).toBe("sess-1");
    expect((await awaitBotReply(app, conv.id, run1.summary as string)).senderType).toBe("bot");

    const secondPosted = await api(app, "POST", `/api/v1/conversations/${conv.id}/messages`, {
      content: "so what should I do first?",
    });
    expect(secondPosted.status).toBe(201);
    const run2 = await awaitRun(app, (secondPosted.body as { runId: string }).runId, "succeeded");
    expect(run2.summary).toBe("Short answer: yes, with caveats");
    expect(await awaitBotReply(app, conv.id, run2.summary as string)).toBeDefined();

    const request1 = recordedRequest(scripted.requests(), 0);
    const request2 = recordedRequest(scripted.requests(), 1);
    expect(String(request1.prompt)).toBe("review my notes");
    expect(String(request1.botId)).toBe(bot.id);
    expect(String(request2.prompt)).toBe("so what should I do first?");
    // The second message resumes the session the first run created.
    expect(request2.sessionId).toBe(run1.sessionId);
    // No bot override and no default model yet, so the app sent none.
    expect(request1.model).toBeUndefined();

    const intervalRes = await api(app, "POST", "/api/v1/schedules", {
      botId: bot.id,
      prompt: "interval ping",
      trigger: { kind: "interval", everyMs: 60_000 },
    });
    expect(intervalRes.status).toBe(201);
    const interval = intervalRes.body as { id: string; nextRunAt: number | null };
    expect(interval.nextRunAt).toBeGreaterThan(Date.now());

    const intervalUpdated = await api(app, "PATCH", `/api/v1/schedules/${interval.id}`, {
      prompt: "renamed interval ping",
    });
    expect(intervalUpdated.status).toBe(200);
    expect((intervalUpdated.body as { prompt: string }).prompt).toBe("renamed interval ping");

    const onceRes = await api(app, "POST", "/api/v1/schedules", {
      botId: bot.id,
      prompt: "morning check-in",
      trigger: { kind: "once", at: Date.now() + 2_000 },
    });
    expect(onceRes.status).toBe(201);
    const once = onceRes.body as { id: string };

    const occurrence = await pollUntil(async () => {
      const res = await api(app, "GET", `/api/v1/schedules/${once.id}/occurrences`);
      const list = res.body as { id: string; status: string; runId: string | null }[];
      return list.find((o) => o.status === "succeeded");
    }, 20_000);
    expect(occurrence.runId).not.toBeNull();

    // The schedule provisions its own direct thread between the bot and the
    // user and posts the reply there.
    const scheduledThread = await pollUntil(async () => {
      const res = await api(app, "GET", "/api/v1/conversations");
      const conversations = res.body as { id: string; title: string; participants: string[] }[];
      return conversations.find(
        (c) => c.title.startsWith("Scheduled:") && c.participants.includes(bot.id),
      );
    }, 20_000);
    const scheduledReply = await awaitBotReply(app, scheduledThread.id, "You're set for the day");
    expect(scheduledReply.senderType).toBe("bot");

    expect((await api(app, "DELETE", `/api/v1/schedules/${interval.id}`)).status).toBe(204);
    expect((await api(app, "DELETE", `/api/v1/schedules/${once.id}`)).status).toBe(204);

    const settingsRes = await api(app, "PUT", "/api/v1/settings", {
      defaultModel: { providerID: "opol", id: "haiku-4.5" },
    });
    expect(settingsRes.status).toBe(200);
    expect((settingsRes.body as { defaultModel: unknown }).defaultModel).toEqual({
      providerID: "opol",
      id: "haiku-4.5",
    });

    const manualRes = await api(app, "POST", `/api/v1/bots/${bot.id}/runs`, {
      prompt: "prep the daily brief",
    });
    expect(manualRes.status).toBe(201);
    const manual = manualRes.body as RunShape & { triggerType: string };
    expect(manual.triggerType).toBe("api");
    const manualRun = await awaitRun(app, manual.id, "succeeded");
    expect(manualRun.summary).toBe("Prepped the daily brief");
    const eventsRes = await api(app, "GET", `/api/v1/runs/${manual.id}/events`);
    expect(JSON.stringify(eventsRes.body)).toContain("progress");

    // The scheduled run recorded its request too; the manual run carried the
    // app-wide default model.
    const requests = scripted.requests();
    expect(String(recordedRequest(requests, 2).prompt)).toBe("morning check-in");
    expect(recordedRequest(requests, 3).model).toEqual({
      providerID: "opol",
      id: "haiku-4.5",
    });

    const failingRes = await api(app, "POST", `/api/v1/bots/${bot.id}/runs`, {
      prompt: "break it",
    });
    expect(failingRes.status).toBe(201);
    const failingRun = await awaitRun(app, (failingRes.body as RunShape).id, "failed");
    expect(failingRun.exitCode).toBe(1);
    expect(failingRun.summary).toBe("boom");

    // --- Restart on the same user-data dir ---------------------------------
    app = await reboot(app);

    const botsAfter = (await api(app, "GET", "/api/v1/bots")).body as {
      id: string;
      name: string;
    }[];
    expect(botsAfter.find((b) => b.id === bot.id)?.name).toBe("Nova Prime");

    const runsAfter = (await api(app, "GET", `/api/v1/bots/${bot.id}/runs`)).body as RunShape[];
    expect(runsAfter).toHaveLength(5);
    expect(runsAfter.filter((r) => r.status === "succeeded")).toHaveLength(4);
    const failedAfter = runsAfter.find((r) => r.status === "failed");
    expect(failedAfter?.summary).toBe("boom");
    expect(failedAfter?.exitCode).toBe(1);

    const messagesAfter = (await api(app, "GET", `/api/v1/conversations/${conv.id}/messages`))
      .body as MessageShape[];
    expect(
      messagesAfter.some((m) => m.senderType === "human" && m.content === "review my notes"),
    ).toBe(true);
    expect(messagesAfter.some((m) => m.content === "Reviewed 3 notes — 2 need follow-up")).toBe(
      true,
    );

    const conversationsAfter = (await api(app, "GET", "/api/v1/conversations")).body as {
      id: string;
      title: string;
      participants: string[];
    }[];
    const scheduledThreadAfter = conversationsAfter.find(
      (c) => c.id === scheduledThread.id && c.title.startsWith("Scheduled:"),
    );
    expect(scheduledThreadAfter).toBeDefined();
    expect(await awaitBotReply(app, scheduledThread.id, "You're set for the day")).toBeDefined();

    const schedulesAfter = (await api(app, "GET", "/api/v1/schedules")).body as { id: string }[];
    expect(schedulesAfter).toEqual([]);

    const settingsAfter = (await api(app, "GET", "/api/v1/settings")).body as {
      defaultModel: unknown;
    };
    expect(settingsAfter.defaultModel).toEqual({ providerID: "opol", id: "haiku-4.5" });

    // The recorder carried across the re-boot (fresh instance, same store).
    expect(scripted.requests()).toHaveLength(5);
  });
});
