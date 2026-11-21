import { describe, expect, it } from "vitest";
import { Effect, Exit, Stream } from "effect";
import {
  asBotId,
  asConversationId,
  asMessageId,
  asScheduleId,
  asScheduleOccurrenceId,
  avatarFromBotId,
} from "@bebots/domain";
import type { Bot, Conversation, Message, Run, Schedule, ScheduleOccurrence } from "@bebots/domain";
import {
  MAX_CATCH_UP_OCCURRENCES,
  MISSED_RUN_HISTORY_WINDOW_MS,
  MAX_ENQUEUE_ATTEMPTS,
  ScheduleService,
  type ScheduleConversationStore,
} from "./schedule-service.js";
import { RunService } from "./run-service.js";
import { RepositoryError } from "./errors.js";
import type { AgentRuntime, RunHandle, RunResult, RuntimeEvent } from "./runtime.js";
import type {
  BotRepository,
  BotWorkspace,
  Clock,
  RunRepository,
  ScheduleRepository,
} from "./repositories.js";

const HOUR = 60 * 60 * 1000;
const MISSED_WINDOW = MISSED_RUN_HISTORY_WINDOW_MS;

function makeBotRepo(): BotRepository {
  const fakeBot = (id: string): Bot => ({
    id: asBotId(id),
    name: "Bot",
    description: "",
    persona: "",
    status: "active",
    avatar: avatarFromBotId(String(id)),
    createdAt: 1,
    updatedAt: 1,
  });
  return {
    create: (bot) => Effect.succeed(bot),
    findById: (id) => Effect.succeed(fakeBot(String(id))),
    findAll: () => Effect.succeed([]),
    update: (bot) => Effect.succeed(bot),
    delete: () => Effect.void,
  };
}

interface ScheduleStore {
  readonly schedules: Map<string, Schedule>;
  readonly occurrences: Map<string, ScheduleOccurrence>;
}

function makeScheduleRepo(store: ScheduleStore): ScheduleRepository {
  const { schedules, occurrences } = store;
  return {
    create: (schedule) =>
      Effect.sync(() => {
        schedules.set(String(schedule.id), schedule);
        return schedule;
      }),
    findById: (id) => Effect.sync(() => schedules.get(String(id)) ?? null),
    findAll: (options) =>
      Effect.sync(() =>
        [...schedules.values()].filter(
          (s) =>
            (!options?.botId || String(s.botId) === String(options.botId)) &&
            (options?.enabled === undefined || s.enabled === options.enabled) &&
            (!options?.createdBy || String(s.createdBy) === options.createdBy),
        ),
      ),
    findDue: (now) =>
      Effect.sync(() =>
        [...schedules.values()].filter(
          (s) => s.enabled && s.nextRunAt !== null && (s.nextRunAt as number) <= now,
        ),
      ),
    update: (schedule) =>
      Effect.sync(() => {
        schedules.set(String(schedule.id), schedule);
        return schedule;
      }),
    delete: (id) =>
      Effect.sync(() => {
        schedules.delete(String(id));
      }),
    createOccurrence: (occurrence) =>
      Effect.sync(() => {
        const existing = [...occurrences.values()].find(
          (o) =>
            String(o.scheduleId) === String(occurrence.scheduleId) &&
            o.scheduledFor === occurrence.scheduledFor,
        );
        if (existing) return existing;
        occurrences.set(String(occurrence.id), occurrence);
        return occurrence;
      }),
    findOccurrence: (id) => Effect.sync(() => occurrences.get(String(id)) ?? null),
    findOccurrenceByRun: (runId) =>
      Effect.sync(
        () =>
          [...occurrences.values()].find((o) => o.runId && String(o.runId) === String(runId)) ??
          null,
      ),
    listOccurrences: (scheduleId, options) => {
      const rows = [...occurrences.values()]
        .filter((o) => String(o.scheduleId) === String(scheduleId))
        .sort((a, b) => b.scheduledFor - a.scheduledFor);
      return Effect.succeed(options?.limit ? rows.slice(0, options.limit) : rows);
    },
    findOccurrences: (options) =>
      Effect.sync(() =>
        [...occurrences.values()]
          .filter((o) => !options?.status || o.status === options.status)
          .sort((a, b) => a.scheduledFor - b.scheduledFor),
      ),
    updateOccurrence: (occurrence) =>
      Effect.sync(() => {
        occurrences.set(String(occurrence.id), occurrence);
        return occurrence;
      }),
    deleteOccurrences: (scheduleId) =>
      Effect.sync(() => {
        let removed = 0;
        for (const [key, o] of occurrences) {
          if (String(o.scheduleId) === String(scheduleId)) {
            occurrences.delete(key);
            removed++;
          }
        }
        return removed;
      }),
  };
}

function makeRunRepo(): RunRepository & { readonly runs: Map<string, Run> } {
  const store = new Map<string, Run>();
  return {
    runs: store,
    create: (run) => {
      store.set(String(run.id), run);
      return Effect.succeed(run);
    },
    findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
    findAll: (opts) =>
      Effect.succeed(
        [...store.values()].filter(
          (run) =>
            (!opts?.botId || String(run.botId) === String(opts.botId)) &&
            (!opts?.status || run.status === opts.status),
        ),
      ),
    update: (run) => {
      store.set(String(run.id), run);
      return Effect.succeed(run);
    },
    appendEvent: () => Effect.void,
    listEvents: () => Effect.succeed([]),
    deleteByBot: () => Effect.succeed(0),
    deleteByConversation: () => Effect.succeed(0),
  };
}

function makeRunService(
  runRepo: RunRepository,
  runtime: AgentRuntime,
  threads?: ScheduleConversationStore,
): RunService {
  return new RunService({
    runRepo,
    botRepo: makeBotRepo(),
    workspace: {
      root: "/tmp",
      ensureHome: () => Effect.succeed("/tmp"),
      writePersona: () => Effect.void,
      homePath: () => "/tmp",
      removeHome: () => Effect.void,
    } as BotWorkspace,
    runtime,
    clock: { now: () => Date.now() },
    ids: { generate: () => crypto.randomUUID() },
    maxConcurrentRuns: 100,
    maxConcurrentRunsPerBot: 100,
    // Mirror production wiring: a finished conversation run posts its summary
    // into the thread as a bot reply.
    ...(threads && {
      conversationMessages: {
        recordBotReply: (conversationId: string, botId: string, content: string) =>
          threads
            .addMessage({ conversationId, content, senderType: "bot", senderId: botId })
            .pipe(Effect.asVoid),
      },
    }),
  });
}

function fakeRuntime(options?: {
  failStart?: boolean;
  exitCode?: number;
  hang?: boolean;
}): AgentRuntime {
  let counter = 0;
  return {
    id: "fake",
    capabilities: { streaming: true, resumableSessions: false, cancellation: true },
    startRun: () =>
      options?.failStart
        ? Effect.fail({ _tag: "RuntimeError", message: "runtime down" })
        : Effect.succeed({ runId: `rt-${++counter}`, sessionId: `s-${counter}` } as RunHandle),
    cancelRun: () => Effect.void,
    streamEvents: () => Stream.fromIterable([] as RuntimeEvent[]),
    getResult: () =>
      options?.hang
        ? Effect.never
        : Effect.succeed({ exitCode: options?.exitCode ?? 0, summary: "done" } as RunResult),
  };
}

interface Fixture {
  readonly store: ScheduleStore;
  readonly runRepo: { readonly runs: Map<string, Run> };
  readonly service: ScheduleService;
  readonly runService: RunService;
  readonly threads?: ThreadsStore;
}

/** In-memory schedule-threads store (mirrors ConversationService's surface). */
type ThreadsStore = ScheduleConversationStore & {
  readonly conversations: Map<string, Conversation>;
  readonly messages: Map<string, Message>;
};

function makeThreads(): ThreadsStore {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, Message>();
  return {
    conversations,
    messages,
    getConversation: (id) => Effect.succeed(conversations.get(id) ?? null),
    createConversation: (input) =>
      Effect.sync(() => {
        const conversation = {
          id: asConversationId(crypto.randomUUID()),
          kind: input?.kind ?? "direct",
          title: input?.title ?? "",
          participants: (input?.participants ?? []).map(String),
          createdAt: 1,
          updatedAt: 1,
        } as Conversation;
        conversations.set(String(conversation.id), conversation);
        return conversation;
      }),
    addMessage: (input) =>
      Effect.sync(() => {
        const message = {
          id: asMessageId(crypto.randomUUID()),
          conversationId: asConversationId(input.conversationId),
          senderType: input.senderType ?? "human",
          senderId: input.senderId ?? null,
          content: input.content,
          deliveryState: input.deliveryState ?? "delivered",
          createdAt: 1,
        } as Message;
        messages.set(String(message.id), message);
        return message;
      }),
  };
}

function makeFixture(
  runtime: AgentRuntime = fakeRuntime(),
  clock: Clock = { now: () => Date.now() },
  threads?: ThreadsStore,
): Fixture {
  const store: ScheduleStore = {
    schedules: new Map(),
    occurrences: new Map(),
  };
  const runRepo = makeRunRepo();
  const runService = makeRunService(runRepo, runtime, threads);
  const service = new ScheduleService({
    scheduleRepo: makeScheduleRepo(store),
    botRepo: makeBotRepo(),
    runService,
    ...(threads && { threads }),
    clock,
    ids: { generate: () => crypto.randomUUID() },
  });
  runService.setScheduleResults(service);
  return { store, runRepo, service, runService, ...(threads && { threads }) };
}

function makeSchedule(
  id: string,
  trigger: Schedule["trigger"],
  now: number,
  overrides?: Partial<Schedule>,
): Schedule {
  const nextRunAt =
    trigger.kind === "once"
      ? trigger.at
      : now + (trigger.kind === "interval" ? trigger.everyMs : HOUR);
  return {
    id: asScheduleId(id),
    botId: asBotId("bot-1"),
    prompt: "scheduled prompt",
    trigger,
    enabled: true,
    conversationId: null,
    createdBy: null,
    anchorAt: now,
    nextRunAt,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Schedule;
}

async function tickAndSettle(service: ScheduleService): Promise<void> {
  await Effect.runPromise(service.tick());
  await new Promise((resolve) => setTimeout(resolve, 80));
}

describe("ScheduleService", () => {
  it("creates schedules with computed nextRunAt and validates triggers", async () => {
    const fixture = makeFixture(undefined, { now: () => 1_000_000 });
    const interval = await Effect.runPromise(
      fixture.service.createSchedule({
        botId: "bot-1",
        prompt: "check in",
        trigger: { kind: "interval", everyMs: 60_000 },
      }),
    );
    expect(interval.nextRunAt).toBe(1_060_000);

    const once = await Effect.runPromise(
      fixture.service.createSchedule({
        botId: "bot-1",
        prompt: "reminder",
        trigger: { kind: "once", at: 1_005_000 },
        createdBy: "bot-2",
      }),
    );
    expect(once.nextRunAt).toBe(1_005_000);

    const cron = await Effect.runPromise(
      fixture.service.createSchedule({
        botId: "bot-1",
        prompt: "weekly",
        trigger: { kind: "cron", expression: "0 9 * * 1", timezone: "UTC" },
      }),
    );
    expect(cron.nextRunAt).toBeGreaterThan(1_000_000);

    const rejected = await Effect.runPromiseExit(
      fixture.service.createSchedule({
        botId: "bot-1",
        prompt: "past",
        trigger: { kind: "once", at: 1_000 },
      }),
    );
    expect(Exit.isFailure(rejected)).toBe(true);

    const badTrigger = await Effect.runPromiseExit(
      fixture.service.createSchedule({
        botId: "bot-1",
        prompt: "bad",
        trigger: { kind: "interval", everyMs: 100 },
      }),
    );
    expect(Exit.isFailure(badTrigger)).toBe(true);
  });

  it("ticks due schedules: enqueues a run with trigger schedule and resolves the occurrence", async () => {
    const now = 2_000_000;
    let clock = now;
    const fixture = makeFixture(fakeRuntime({ exitCode: 0 }), { now: () => clock });
    fixture.store.schedules.set(
      "s-1",
      makeSchedule("s-1", { kind: "interval", everyMs: HOUR }, now),
    );

    clock = now + HOUR + 1;
    const summary = await Effect.runPromise(fixture.service.tick());
    expect(summary.enqueued).toBe(1);

    const schedule = fixture.store.schedules.get("s-1")!;
    expect(schedule.nextRunAt).toBe(now + 2 * HOUR);
    expect(schedule.lastRunAt).toBe(now + HOUR + 1);

    const runs = [...fixture.runRepo.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.triggerType).toBe("schedule");

    const occurrence = [...fixture.store.occurrences.values()][0]!;
    expect(occurrence.status).toBe("enqueued");
    expect(String(occurrence.runId)).toBe(String(runs[0]!.id));

    await tickAndSettle(fixture.service);
    const resolved = await Effect.runPromise(fixture.service.listHistory("s-1"));
    expect(resolved[0]!.status).toBe("succeeded");

    // Re-tick: the already-enqueued occurrence is not duplicated.
    const summary2 = await Effect.runPromise(fixture.service.tick());
    expect(summary2.enqueued).toBe(0);
    expect(fixture.runRepo.runs.size).toBe(1);
  });

  it("resumes a conversation session when the schedule carries one", async () => {
    const now = 2_500_000;
    let clock = now;
    const fixture = makeFixture(fakeRuntime({ exitCode: 0 }), { now: () => clock });
    fixture.store.schedules.set(
      "soc",
      makeSchedule("soc", { kind: "once", at: now }, now, {
        conversationId: asConversationId("conv-9"),
      }),
    );

    clock = now + 1;
    await tickAndSettle(fixture.service);
    const run = [...fixture.runRepo.runs.values()][0]!;
    expect(String(run.conversationId)).toBe("conv-9");
    expect(run.conversationSessionId ?? run.sessionId).toBeTruthy();
  });

  it("a scheduled fire becomes a conversation between the bot and the user", async () => {
    const now = 3_000_000;
    let clock = now;
    const threads = makeThreads();
    const fixture = makeFixture(fakeRuntime({ exitCode: 0 }), { now: () => clock }, threads);
    fixture.store.schedules.set(
      "s-conv",
      makeSchedule("s-conv", { kind: "once", at: now }, now, { prompt: "daily standup report" }),
    );

    clock = now + 1;
    await tickAndSettle(fixture.service);

    const run = [...fixture.runRepo.runs.values()][0]!;
    expect(run.triggerType).toBe("schedule");
    // The schedule's prompt is passed verbatim to the session.
    expect(run.prompt).toBe("daily standup report");
    expect(run.conversationId).toBeTruthy();

    // The schedule is linked to its thread.
    const schedule = fixture.store.schedules.get("s-conv")!;
    expect(String(schedule.conversationId)).toBe(String(run.conversationId));

    // Thread shape: a direct conversation between the bot and the user.
    expect(threads.conversations.size).toBe(1);
    const thread = threads.conversations.get(String(run.conversationId))!;
    expect(thread.participants).toEqual(["bot-1", "human"]);
    expect(thread.title).toBe("Scheduled: daily standup report");

    // The trigger marker and the bot's reply both land in the thread.
    const threadMessages = [...threads.messages.values()];
    expect(threadMessages.map((m) => m.senderType)).toEqual(["system", "bot"]);
    expect(threadMessages[0]!.content).toContain("Scheduled run triggered");
    expect(String(threadMessages[0]!.conversationId)).toBe(String(run.conversationId));
    expect(String(threadMessages[1]!.senderId)).toBe("bot-1");
    expect(threadMessages[1]!.content).toBe("done");
  });

  it("later firings of the same schedule reuse its thread", async () => {
    const now = 4_000_000;
    let clock = now;
    const threads = makeThreads();
    const fixture = makeFixture(fakeRuntime({ exitCode: 0 }), { now: () => clock }, threads);
    fixture.store.schedules.set(
      "s-reuse",
      makeSchedule("s-reuse", { kind: "interval", everyMs: HOUR }, now),
    );

    clock = now + HOUR + 1;
    await tickAndSettle(fixture.service);
    clock = now + 2 * HOUR + 1;
    await tickAndSettle(fixture.service);

    expect(fixture.runRepo.runs.size).toBe(2);
    const ids = [...fixture.runRepo.runs.values()].map((r) => String(r.conversationId));
    expect(new Set(ids).size).toBe(1);
    expect(threads.conversations.size).toBe(1);
    // One trigger marker per fire.
    const markers = [...threads.messages.values()].filter((m) => m.senderType === "system");
    expect(markers).toHaveLength(2);
  });

  it("provisions a fresh thread when the schedule's thread was deleted", async () => {
    const now = 5_000_000;
    let clock = now;
    const threads = makeThreads();
    const fixture = makeFixture(fakeRuntime({ exitCode: 0 }), { now: () => clock }, threads);
    fixture.store.schedules.set(
      "s-del",
      makeSchedule("s-del", { kind: "interval", everyMs: HOUR }, now),
    );

    clock = now + HOUR + 1;
    await tickAndSettle(fixture.service);
    const first = String(fixture.store.schedules.get("s-del")!.conversationId);
    threads.conversations.delete(first);

    clock = now + 2 * HOUR + 1;
    await tickAndSettle(fixture.service);
    const second = String(fixture.store.schedules.get("s-del")!.conversationId);
    expect(second).not.toBe(first);
    expect(threads.conversations.size).toBe(1);
    const runs = [...fixture.runRepo.runs.values()];
    expect(String(runs[1]!.conversationId)).toBe(second);
  });

  it("marks the trigger in an explicit conversation without provisioning", async () => {
    const now = 6_000_000;
    let clock = now;
    const threads = makeThreads();
    const fixture = makeFixture(fakeRuntime({ exitCode: 0 }), { now: () => clock }, threads);
    threads.conversations.set("conv-explicit", {
      id: asConversationId("conv-explicit"),
      kind: "direct",
      title: "Existing thread",
      participants: ["bot-1", "human"],
      createdAt: 1,
      updatedAt: 1,
    });
    fixture.store.schedules.set(
      "s-explicit",
      makeSchedule("s-explicit", { kind: "once", at: now }, now, {
        conversationId: asConversationId("conv-explicit"),
      }),
    );

    clock = now + 1;
    await tickAndSettle(fixture.service);
    const run = [...fixture.runRepo.runs.values()][0]!;
    expect(String(run.conversationId)).toBe("conv-explicit");
    expect(threads.conversations.size).toBe(1);
    const inThread = [...threads.messages.values()].filter(
      (m) => String(m.conversationId) === "conv-explicit",
    );
    // The trigger marker lands first; the bot's reply follows like any
    // conversation run's answer.
    expect(inThread.map((m) => m.senderType)).toEqual(["system", "bot"]);
    expect(inThread[0]!.content).toContain("Scheduled run triggered");
  });

  it("still fires the run when thread provisioning fails", async () => {
    const now = 7_000_000;
    let clock = now;
    const threads = makeThreads();
    const broken: ThreadsStore = {
      ...threads,
      createConversation: () => Effect.fail(new RepositoryError("db down")),
    };
    const fixture = makeFixture(fakeRuntime({ exitCode: 0 }), { now: () => clock }, broken);
    fixture.store.schedules.set(
      "s-broken",
      makeSchedule("s-broken", { kind: "once", at: now }, now),
    );

    clock = now + 1;
    const summary = await Effect.runPromise(fixture.service.tick());
    expect(summary.enqueued).toBe(1);
    const run = [...fixture.runRepo.runs.values()][0]!;
    expect(run.conversationId).toBeUndefined();
    const schedule = fixture.store.schedules.get("s-broken")!;
    expect(schedule.conversationId).toBeNull();
  });

  it("surfaces a failed scheduled run in its thread", async () => {
    const now = 8_000_000;
    let clock = now;
    const threads = makeThreads();
    const fixture = makeFixture(fakeRuntime({ exitCode: 1 }), { now: () => clock }, threads);
    fixture.store.schedules.set("s-fail", makeSchedule("s-fail", { kind: "once", at: now }, now));

    clock = now + 1;
    await tickAndSettle(fixture.service);
    const resolved = await Effect.runPromise(fixture.service.listHistory("s-fail"));
    expect(resolved[0]!.status).toBe("failed");
    const systemMessages = [...threads.messages.values()].filter((m) => m.senderType === "system");
    expect(systemMessages.map((m) => m.content)).toContain("Scheduled run failed");
  });

  it("applies the missed-run policy: backlog beyond 2 days is skipped, catch-up is capped", async () => {
    const now = 3_000_000;
    const fixture = makeFixture(fakeRuntime(), { now: () => now });
    // 10-minute interval whose nextRunAt is 5 days in the past (app off).
    fixture.store.schedules.set(
      "s-backlog",
      makeSchedule(
        "s-backlog",
        { kind: "interval", everyMs: 600_000 },
        now - MISSED_WINDOW - 2 * 86_400_000,
        {
          anchorAt: now - MISSED_WINDOW - 2 * 86_400_000,
          nextRunAt: now - 2 * 86_400_000 - 600_000,
        },
      ),
    );

    const summary = await Effect.runPromise(fixture.service.tick());
    expect(summary.enqueued).toBe(MAX_CATCH_UP_OCCURRENCES);
    expect(summary.missed).toBeGreaterThan(0);
    expect(fixture.runRepo.runs.size).toBe(MAX_CATCH_UP_OCCURRENCES);
    expect([...fixture.store.occurrences.values()].length).toBe(MAX_CATCH_UP_OCCURRENCES);

    const schedule = fixture.store.schedules.get("s-backlog")!;
    expect((schedule.nextRunAt as number) > now).toBe(true);
  });

  it("retries failed enqueueing and marks the occurrence failed after the attempt limit", async () => {
    const now = 1_500_000;
    const fixture = makeFixture(fakeRuntime({ failStart: true }), { now: () => now });
    fixture.store.schedules.set("s-retry", makeSchedule("s-retry", { kind: "once", at: now }, now));

    for (let i = 1; i <= MAX_ENQUEUE_ATTEMPTS; i++) {
      await Effect.runPromise(fixture.service.tick());
      const occurrence = [...fixture.store.occurrences.values()][0]!;
      if (occurrence.status === "failed") {
        expect(i).toBe(MAX_ENQUEUE_ATTEMPTS);
        break;
      }
      expect(occurrence.status).toBe("pending");
      expect(occurrence.attempts).toBe(i);
      expect(occurrence.error).toContain("runtime down");
    }
    expect([...fixture.store.occurrences.values()][0]!.status).toBe("failed");
  });

  it("enable/disable recompute nextRunAt; delete removes schedule and occurrences", async () => {
    const now = 10_000_000;
    const fixture = makeFixture(fakeRuntime(), { now: () => now });
    fixture.store.schedules.set(
      "s-toggle",
      makeSchedule("s-toggle", { kind: "interval", everyMs: HOUR }, now),
    );
    fixture.store.occurrences.set("o-1", {
      id: asScheduleOccurrenceId("o-1"),
      scheduleId: asScheduleId("s-toggle"),
      scheduledFor: now,
      status: "pending",
      runId: null,
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    } as ScheduleOccurrence);

    const disabled = await Effect.runPromise(
      fixture.service.updateSchedule("s-toggle", { enabled: false }),
    );
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeNull();

    const reenabled = await Effect.runPromise(
      fixture.service.updateSchedule("s-toggle", { enabled: true }),
    );
    expect(reenabled.nextRunAt).toBe(now + 60 * 60 * 1000);

    await Effect.runPromise(fixture.service.deleteSchedule("s-toggle"));
    expect(fixture.store.schedules.size).toBe(0);
    expect(fixture.store.occurrences.size).toBe(0);
  });

  it("recovers stale occurrences after a restart", async () => {
    const now = 20_000_000;
    const fixture = makeFixture(fakeRuntime({ exitCode: 0 }), { now: () => now });
    // Occurrence enqueued against a run whose record is gone (restart);
    // its schedule no longer exists either — recovery should drop it back
    // to pending, not to enqueued.
    fixture.store.occurrences.set("o-pending", {
      id: asScheduleOccurrenceId("o-pending"),
      scheduleId: asScheduleId("s-alive"),
      scheduledFor: now - HOUR,
      status: "pending",
      runId: null,
      attempts: 0,
      error: "Application restarted during run",
      createdAt: now - HOUR,
      updatedAt: now - HOUR,
    } as ScheduleOccurrence);
    fixture.store.schedules.set(
      "s-alive",
      makeSchedule("s-alive", { kind: "interval", everyMs: 10 * HOUR }, now, {
        nextRunAt: now + 10 * HOUR,
      }),
    );

    const summary = await Effect.runPromise(fixture.service.tick());
    expect(summary.enqueued).toBe(1);
    const occurrence = fixture.store.occurrences.get("o-pending")!;
    expect(occurrence.status).toBe("enqueued");
    expect(fixture.runRepo.runs.size).toBe(1);

    await tickAndSettle(fixture.service);
    const resolved = [...fixture.store.occurrences.values()][0]!;
    expect(resolved.status).toBe("succeeded");
  });

  it("resolves a cancelled scheduled run as cancelled occurrence", async () => {
    const now = 30_000_000;
    let clockNow = now;
    const fixture = makeFixture(fakeRuntime({ hang: true }), { now: () => clockNow });
    fixture.store.schedules.set(
      "s-cancel",
      makeSchedule("s-cancel", { kind: "once", at: now + 1 }, now),
    );
    clockNow = now + 2;
    await tickAndSettle(fixture.service);
    const run = [...fixture.runRepo.runs.values()][0]!;
    await Effect.runPromise(fixture.runService.cancelRun(run.id));
    const occurrence = [...fixture.store.occurrences.values()][0]!;
    expect(occurrence.status).toBe("cancelled");
  });
});
