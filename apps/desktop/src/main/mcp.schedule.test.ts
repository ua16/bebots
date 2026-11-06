import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api as sharedApi,
  bootTestApp,
  createBot as createBotViaApi,
  mcpRpc,
  toolPayload,
  type BootedApp,
} from "./test-boot";

type ScheduleTriggerPayload =
  | { kind: "interval"; everyMs: number }
  | { kind: "once"; at: number }
  | { kind: "cron"; expression: string; timezone: string };

type SchedulePayload = {
  scheduleId: string;
  botId: string;
  prompt: string;
  trigger: ScheduleTriggerPayload;
  enabled: boolean;
  nextRunAt: number | null;
};

// The fake runtime placeholder mirrors the other MCP boot tests.
vi.mock("@bebots/runtime-opencode", async () => {
  const { Effect, Stream } = await import("effect");
  let runs = 0;
  class FakeRuntime {
    readonly id = "fake";
    readonly capabilities = { streaming: true, resumableSessions: true, cancellation: true };
    startRun() {
      ++runs;
      return Effect.succeed({ runId: `rt-${runs}`, sessionId: `sess-${runs}` });
    }
    cancelRun() {
      return Effect.void;
    }
    streamEvents() {
      return Stream.empty;
    }
    getResult() {
      return Effect.succeed({ exitCode: 0, summary: "ok" });
    }
    close() {}
  }
  return {
    OpenCodeRuntime: FakeRuntime,
    createOpenCodeRuntime: () => new FakeRuntime(),
  };
});

describe("MCP schedule tools (live app boot)", () => {
  let app: BootedApp;

  beforeEach(async () => {
    app = await bootTestApp({
      tmpPrefix: "bebots-mcp-schedule-",
      // Fast scheduler ticks so fired schedules execute within the test.
      env: {
        BEBOTS_SCHEDULE_TICK_MS: "150",
        ELECTRON_RENDERER_URL: "http://localhost:5173",
      },
    });
  });

  afterEach(() => {
    app.dispose();
  });

  function api(method: string, path: string, body?: unknown) {
    return sharedApi(app, method, path, body);
  }

  function rpc(method: string, params: Record<string, unknown>, id: number, botId: string) {
    return mcpRpc(app, method, params, id, { "X-Bebots-Bot-Id": botId }).then(
      (result) => result.body,
    );
  }

  function createBot(name: string): Promise<{ id: string }> {
    return createBotViaApi(app, name);
  }

  it("schedule_run/list_schedules/cancel_schedule work end to end", async () => {
    const botA = await createBot("Scheduler");
    const botB = await createBot("Receiver");

    await rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
      1,
      botA.id,
    );

    const tools = (await rpc("tools/list", {}, 2, botA.id)).result?.tools?.map((t) => t.name) ?? [];
    expect(tools).toContain("schedule_run");
    expect(tools).toContain("list_schedules");
    expect(tools).toContain("cancel_schedule");

    // Schedule a recurring run for another bot through MCP.
    const scheduled = toolPayload<SchedulePayload>(
      await rpc(
        "tools/call",
        {
          name: "schedule_run",
          arguments: { prompt: "morning check-in", bot_id: botB.id, every_minutes: 5 },
        },
        3,
        botA.id,
      ),
    );
    expect(scheduled.botId).toBe(botB.id);
    expect(scheduled.trigger).toEqual({ kind: "interval", everyMs: 300_000 });
    expect(scheduled.enabled).toBe(true);
    expect(scheduled.nextRunAt).toBeGreaterThan(Date.now());

    // Schedule a one-shot run for the caller itself (default target).
    const once = toolPayload<SchedulePayload>(
      await rpc(
        "tools/call",
        {
          name: "schedule_run",
          arguments: { prompt: "self reminder", at: new Date(Date.now() + 60_000).toISOString() },
        },
        4,
        botA.id,
      ),
    );
    expect(String(once.botId)).toBe(botA.id);
    expect(once.trigger.kind).toBe("once");
    expect(once.trigger.kind === "once" && once.trigger.at > Date.now()).toBe(true);

    // Via HTTP, the schedule is visible including its creator.
    const listedViaHttp = (
      await api("GET", `/api/v1/schedules?createdBy=${encodeURIComponent(botA.id)}`)
    ).body as {
      id: string;
      createdBy: string;
    }[];
    expect(listedViaHttp.map((s) => s.id)).toContain(scheduled.scheduleId);
    expect(listedViaHttp[0]?.createdBy).toBe(botA.id);

    // list_schedules shows exactly the two created above.
    const mine = toolPayload<SchedulePayload[]>(
      await rpc(
        "tools/call",
        {
          name: "list_schedules",
          arguments: {},
        },
        5,
        botA.id,
      ),
    );
    expect(mine.map((s) => s.scheduleId).sort()).toEqual(
      [scheduled.scheduleId, once.scheduleId].sort(),
    );

    // Rejects ambiguous triggers and unrelated targets.
    const bad = await rpc(
      "tools/call",
      {
        name: "schedule_run",
        arguments: { prompt: "x", every_minutes: 5, at: "2026-12-01T00:00:00Z" },
      },
      6,
      botA.id,
    );
    expect(
      bad.error !== undefined || (bad.result?.content?.[0]?.text ?? "").includes("exactly one"),
    ).toBe(true);

    // cancel_schedule removes it, including its occurrence history.
    const cancelled = toolPayload<{ cancelledScheduleId: string }>(
      await rpc(
        "tools/call",
        {
          name: "cancel_schedule",
          arguments: { schedule_id: scheduled.scheduleId },
        },
        7,
        botA.id,
      ),
    );
    expect(cancelled.cancelledScheduleId).toBe(scheduled.scheduleId);
    expect((await api("GET", `/api/v1/schedules/${scheduled.scheduleId}`)).status).toBe(404);

    // Another bot cannot cancel bot A's schedule.
    const sneaky = toolPayload<SchedulePayload>(
      await rpc(
        "tools/call",
        {
          name: "schedule_run",
          arguments: { prompt: "sneaky", every_minutes: 10 },
        },
        8,
        botA.id,
      ),
    );
    await rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
      9,
      botB.id,
    );
    const denied = await rpc(
      "tools/call",
      {
        name: "cancel_schedule",
        arguments: { schedule_id: sneaky.scheduleId },
      },
      10,
      botB.id,
    );
    expect(
      (denied.result?.content?.[0]?.text ?? "").includes("not yours") || denied.error !== undefined,
    ).toBe(true);
  });

  it("schedule_run rejects a cron expression that can never fire", async () => {
    const bot = await createBot("ImpossibleCron");
    await rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
      1,
      bot.id,
    );

    // February never has a 30th: the tool must refuse the trigger outright,
    // rather than creating an enabled schedule that silently never fires.
    const denied = await rpc(
      "tools/call",
      {
        name: "schedule_run",
        arguments: { prompt: "impossible", cron: "0 0 30 2 *" },
      },
      2,
      bot.id,
    );
    expect(denied.result?.isError).toBe(true);
    expect((denied.result?.content?.[0]?.text ?? "").includes("never fires")).toBe(true);

    // Nothing was persisted for the impossible trigger.
    const created = (await api("GET", `/api/v1/schedules?createdBy=${encodeURIComponent(bot.id)}`))
      .body as { id: string }[];
    expect(created).toEqual([]);

    // A leap-day cron is rare but real, so it stays acceptable.
    const leapDay = toolPayload<SchedulePayload>(
      await rpc(
        "tools/call",
        {
          name: "schedule_run",
          arguments: { prompt: "leap day", cron: "0 0 29 2 *" },
        },
        3,
        bot.id,
      ),
    );
    expect(leapDay.enabled).toBe(true);
    expect(leapDay.nextRunAt).not.toBeNull();
  });

  it("a fired schedule runs in its own thread with the user and posts the result there", async () => {
    const bot = await createBot("SchedConverser");
    await rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
      1,
      bot.id,
    );

    // One-shot schedule for the caller itself, firing ~1.5s out, with no
    // conversation_id: the scheduler must provision the thread.
    const scheduled = toolPayload<SchedulePayload>(
      await rpc(
        "tools/call",
        {
          name: "schedule_run",
          arguments: { prompt: "morning check-in", at: new Date(Date.now() + 1_500).toISOString() },
        },
        2,
        bot.id,
      ),
    );
    expect(scheduled.botId).toBe(bot.id);

    // Poll until the run fires and the reply lands in the provisioned thread.
    const deadline = Date.now() + 20_000;
    type ThreadMessage = { senderType: string; content: string; senderId?: string | null };
    let thread: { id: string; title: string; participants: string[] } | undefined;
    let messages: ThreadMessage[] = [];
    while (Date.now() < deadline) {
      const conversations = (await api("GET", "/api/v1/conversations")).body as {
        id: string;
        title: string;
        participants: string[];
      }[];
      thread = conversations.find(
        (c) => c.participants.includes(bot.id) && c.participants.includes("human"),
      );
      if (thread) {
        messages = (await api("GET", `/api/v1/conversations/${thread.id}/messages`))
          .body as ThreadMessage[];
        if (messages.some((m) => m.senderType === "bot")) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // The schedule provisioned its own direct thread between the bot and the user.
    expect(thread).toBeDefined();
    expect(thread!.title.startsWith("Scheduled:")).toBe(true);
    // The trigger is visible in the thread, and the bot's result is posted as
    // its reply — a conversation, not a hidden run.
    expect(
      messages.some(
        (m) => m.senderType === "system" && m.content.includes("Scheduled run triggered"),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.senderType === "bot" && m.content === "ok")).toBe(true);

    // The schedule row is linked to the thread so later firings reuse it.
    const stored = (await api("GET", `/api/v1/schedules/${scheduled.scheduleId}`)).body as {
      conversationId?: string | null;
    };
    expect(stored.conversationId).toBe(thread!.id);
  });
});
