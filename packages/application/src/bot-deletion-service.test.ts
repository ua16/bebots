import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { Cause } from "effect";
import {
  asActivityId,
  asBotId,
  asConversationId,
  asConversationSessionId,
  asMessageId,
  asRunId,
  asScheduleId,
  asScheduleOccurrenceId,
  avatarFromBotId,
} from "@bebots/domain";
import type {
  ActivityEvent,
  Bot,
  Conversation,
  ConversationSession,
  Message,
  Run,
  Schedule,
  ScheduleOccurrence,
  Task,
} from "@bebots/domain";
import type {
  BotRepository,
  BotWorkspace,
  ConversationRepository,
  ConversationSessionRepository,
  FileIndexRepository,
  MessageRepository,
  RunRepository,
  TaskRepository,
} from "./repositories.js";
import { RunService } from "./run-service.js";
import { ScheduleService } from "./schedule-service.js";
import { ConversationRunCoordinator } from "./conversation-run-coordinator.js";
import { ConversationService } from "./conversation-service.js";
import { BotDeletionService } from "./bot-deletion-service.js";
import type { AgentRuntime, RunHandle, RunRequest } from "./runtime.js";

// ---------------------------------------------------------------------------
// Store-backed fakes. Every mutation appends to `log` so tests can assert the
// cascade ordering that BotDeletionService's invariants depend on.
// ---------------------------------------------------------------------------

interface Stores {
  readonly bots: Map<string, Bot>;
  readonly conversations: Map<string, Conversation>;
  readonly messages: Map<string, Message>;
  readonly sessions: Map<string, ConversationSession>;
  readonly runs: Map<string, Run>;
  readonly runEvents: Map<string, unknown[]>;
  readonly tasks: Map<string, Task>;
  readonly fileIndex: Map<string, { botId: string; path: string }>;
  readonly activity: Map<string, ActivityEvent>;
}

function makeStores(): Stores {
  return {
    bots: new Map(),
    conversations: new Map(),
    messages: new Map(),
    sessions: new Map(),
    runs: new Map(),
    runEvents: new Map(),
    tasks: new Map(),
    fileIndex: new Map(),
    activity: new Map(),
  };
}

function makeBotRepo(stores: Stores, log: string[]): BotRepository {
  return {
    create: (bot) => {
      stores.bots.set(String(bot.id), bot);
      return Effect.succeed(bot);
    },
    findById: (id) => Effect.succeed(stores.bots.get(String(id)) ?? null),
    findAll: () => Effect.succeed([...stores.bots.values()]),
    update: (bot) => {
      stores.bots.set(String(bot.id), bot);
      return Effect.succeed(bot);
    },
    delete: (id) => {
      const removed = stores.bots.delete(String(id));
      log.push(`delete-bot:${id}`);
      return removed ? Effect.void : Effect.void;
    },
  };
}

function makeConversationRepo(stores: Stores, log: string[]): ConversationRepository {
  return {
    create: (c) => {
      stores.conversations.set(String(c.id), c);
      return Effect.succeed(c);
    },
    findById: (id) => Effect.succeed(stores.conversations.get(String(id)) ?? null),
    // participants is a JSON column; the sqlite repo filters in JS, so does
    // this fake.
    findAll: (options?: { readonly kind?: string; readonly participant?: string }) =>
      Effect.succeed(
        [...stores.conversations.values()].filter(
          (c) =>
            (!options?.kind || c.kind === options.kind) &&
            (!options?.participant || c.participants.includes(options.participant)),
        ),
      ),
    update: (c) => {
      stores.conversations.set(String(c.id), c);
      return Effect.succeed(c);
    },
    delete: (id) => {
      stores.conversations.delete(String(id));
      log.push(`delete-conversation:${id}`);
      return Effect.void;
    },
  };
}

function makeMessageRepo(stores: Stores): MessageRepository {
  return {
    create: (m: Message) => {
      stores.messages.set(String(m.id), m);
      return Effect.succeed(m);
    },
    findById: (id: string) => Effect.succeed(stores.messages.get(String(id)) ?? null),
    findByConversation: (conversationId: string) =>
      Effect.succeed(
        [...stores.messages.values()].filter(
          (m) => String(m.conversationId) === String(conversationId),
        ),
      ),
    findAll: () => Effect.succeed([...stores.messages.values()]),
    update: (m: Message) => {
      stores.messages.set(String(m.id), m);
      return Effect.succeed(m);
    },
    deleteByConversation: (conversationId: string) => {
      let removed = 0;
      for (const [id, m] of [...stores.messages]) {
        if (String(m.conversationId) === String(conversationId)) {
          stores.messages.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    delete: (id: string) => {
      stores.messages.delete(String(id));
      return Effect.void;
    },
  };
}

function makeSessionRepo(stores: Stores): ConversationSessionRepository {
  return {
    create: (s) => {
      stores.sessions.set(String(s.id), s);
      return Effect.succeed(s);
    },
    findById: (id) => Effect.succeed(stores.sessions.get(String(id)) ?? null),
    findLatestByConversation: (conversationId, options) =>
      Effect.succeed(
        [...stores.sessions.values()]
          .filter(
            (s) =>
              String(s.conversationId) === String(conversationId) &&
              (!options?.status || s.status === options.status) &&
              (options?.botId === undefined || (s.botId ?? null) === options.botId),
          )
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null,
      ),
    findAll: () => Effect.succeed([...stores.sessions.values()]),
    update: (s) => {
      stores.sessions.set(String(s.id), s);
      return Effect.succeed(s);
    },
    deleteByConversation: (conversationId) => {
      let removed = 0;
      for (const [id, s] of [...stores.sessions]) {
        if (String(s.conversationId) === String(conversationId)) {
          stores.sessions.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    deleteByBot: (botId) => {
      let removed = 0;
      for (const [id, s] of [...stores.sessions]) {
        if (s.botId !== null && String(s.botId) === String(botId)) {
          stores.sessions.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    delete: (id) => {
      stores.sessions.delete(String(id));
      return Effect.void;
    },
  };
}

function makeRunRepo(stores: Stores, log: string[]): RunRepository {
  return {
    create: (run) => {
      stores.runs.set(String(run.id), run);
      return Effect.succeed(run);
    },
    findById: (id) => Effect.succeed(stores.runs.get(String(id)) ?? null),
    findAll: (options) =>
      Effect.succeed(
        [...stores.runs.values()].filter(
          (r) =>
            (!options?.botId || String(r.botId) === String(options.botId)) &&
            (!options?.status || r.status === options.status) &&
            (!options?.conversationId ||
              (r.conversationId !== undefined &&
                String(r.conversationId) === String(options.conversationId))),
        ),
      ),
    update: (run) => {
      const previous = stores.runs.get(String(run.id));
      if (run.status === "cancelled" && previous?.status !== "cancelled") {
        log.push(`cancel-run:${run.id}`);
      }
      stores.runs.set(String(run.id), run);
      return Effect.succeed(run);
    },
    appendEvent: (runId, event) => {
      const arr = stores.runEvents.get(String(runId)) ?? [];
      arr.push(event);
      stores.runEvents.set(String(runId), arr);
      return Effect.void;
    },
    listEvents: () => Effect.succeed([]),
    deleteByBot: (botId) => {
      let removed = 0;
      for (const [id, run] of [...stores.runs]) {
        if (String(run.botId) === String(botId)) {
          stores.runs.delete(id);
          stores.runEvents.delete(id);
          removed++;
        }
      }
      log.push(`delete-runs-bot:${botId}`);
      return Effect.succeed(removed);
    },
    deleteByConversation: (conversationId) => {
      let removed = 0;
      for (const [id, run] of [...stores.runs]) {
        if (
          run.conversationId !== undefined &&
          String(run.conversationId) === String(conversationId)
        ) {
          stores.runs.delete(id);
          stores.runEvents.delete(id);
          removed++;
        }
      }
      log.push(`delete-runs-conversation:${conversationId}`);
      return Effect.succeed(removed);
    },
  };
}

function makeTaskRepo(stores: Stores): TaskRepository {
  return {
    create: (task) => {
      stores.tasks.set(String(task.id), task);
      return Effect.succeed(task);
    },
    findById: (id) => Effect.succeed(stores.tasks.get(String(id)) ?? null),
    findAll: () => Effect.succeed([...stores.tasks.values()]),
    update: (task) => {
      stores.tasks.set(String(task.id), task);
      return Effect.succeed(task);
    },
    deleteByBot: (botId) => {
      let removed = 0;
      for (const [id, task] of [...stores.tasks]) {
        if (task.assignee === String(botId) || task.requester === String(botId)) {
          stores.tasks.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    delete: (id) => {
      stores.tasks.delete(String(id));
      return Effect.void;
    },
    findByIdempotencyKey: () => Effect.succeed(null),
  };
}

function makeActivityRepo(stores: Stores) {
  return {
    create: (event: ActivityEvent) => {
      stores.activity.set(String(event.id), event);
      return Effect.succeed(event);
    },
    findAll: () => Effect.succeed([...stores.activity.values()]),
    deleteByEntityIds: (entityType: string, entityIds: readonly string[]) => {
      let removed = 0;
      for (const [id, event] of [...stores.activity]) {
        if (event.entityType === entityType && entityIds.map(String).includes(event.entityId)) {
          stores.activity.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
  };
}

function makeFileIndexRepo(stores: Stores): FileIndexRepository {
  return {
    upsert: () => Effect.void as never,
    remove: () => Effect.void,
    removeUnderPrefix: () => Effect.succeed(0),
    removeByBot: (botId) => {
      let removed = 0;
      for (const [key, entry] of [...stores.fileIndex]) {
        if (entry.botId === String(botId)) {
          stores.fileIndex.delete(key);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    search: () => Effect.succeed([]),
  };
}

function makeWorkspace(stores: Stores, log: string[]): BotWorkspace {
  return {
    root: "/tmp/bots",
    ensureHome: () => Effect.succeed("/tmp/bots/x"),
    writePersona: () => Effect.void,
    homePath: () => "/tmp/bots/x",
    removeHome: (botId) => {
      // The watcher prunes only the deleted bot's subtree, not other bots'.
      for (const [key, entry] of [...stores.fileIndex]) {
        if (entry.botId === String(botId)) stores.fileIndex.delete(key);
      }
      log.push(`remove-home:${botId}`);
      return Effect.void;
    },
    storeReceivedFile: () => Effect.succeed({ savedName: "file", size: 0 }),
    readReceivedFile: () => Effect.succeed(null),
    removeReceivedFile: () => Effect.succeed(false),
    removeReceivedConversationDir: () => Effect.void,
  };
}

/** Runtime whose cancellation is recorded so tests can assert run sweeps. */
function makeRuntime(log: string[]): AgentRuntime {
  return {
    id: "fake",
    capabilities: { streaming: false, resumableSessions: false, cancellation: true },
    startRun: (_request: RunRequest) =>
      Effect.succeed({ runId: "rt-1", sessionId: "sess-1" } as RunHandle),
    streamEvents: () => {
      throw new Error("not used");
    },
    getResult: () => {
      throw new Error("not used");
    },
    cancelRun: (_handle: RunHandle) => {
      log.push("cancel-runtime");
      return Effect.void;
    },
  } as unknown as AgentRuntime;
}

/**
 * ScheduleRepository fake (only what ScheduleService.delete/list use here).
 * The returned `repo` is cast at the ScheduleService construction site; the
 * maps are typed so the seeds below must be well-formed domain objects.
 */
function makeScheduleRepoHarness(log: string[]) {
  const schedules = new Map<string, Schedule>();
  const occurrences = new Map<string, ScheduleOccurrence[]>();
  let failure: { id: string; error: Error } | null = null;
  const repo = {
    create: (schedule: Schedule) => {
      schedules.set(String(schedule.id), schedule);
      return Effect.succeed(schedule);
    },
    findById: (id: string) => Effect.succeed(schedules.get(String(id)) ?? null),
    findAll: (options?: {
      readonly botId?: string;
      readonly enabled?: boolean;
      readonly createdBy?: string;
      readonly conversationId?: string;
      readonly limit?: number;
    }) =>
      Effect.succeed(
        [...schedules.values()].filter(
          (s) =>
            (!options?.botId || String(s.botId) === String(options.botId)) &&
            (!options?.createdBy || s.createdBy === options.createdBy) &&
            (!options?.conversationId || s.conversationId === options.conversationId),
        ),
      ),
    findDue: () => Effect.succeed([]),
    update: (schedule: Schedule) => {
      schedules.set(String(schedule.id), schedule);
      return Effect.succeed(schedule);
    },
    delete: (id: string) => {
      if (failure && failure.id === String(id)) return Effect.fail(failure.error);
      schedules.delete(String(id));
      log.push(`delete-schedule:${id}`);
      return Effect.succeed(undefined);
    },
    createOccurrence: (occ: ScheduleOccurrence) => {
      const arr = occurrences.get(String(occ.scheduleId)) ?? [];
      arr.push(occ);
      occurrences.set(String(occ.scheduleId), arr);
      return Effect.succeed(occ);
    },
    findOccurrence: () => Effect.succeed(null),
    findOccurrenceByRun: () => Effect.succeed(null),
    listOccurrences: (scheduleId: string) =>
      Effect.succeed(occurrences.get(String(scheduleId)) ?? []),
    findOccurrences: () => Effect.succeed([]),
    updateOccurrence: (occ: ScheduleOccurrence) => Effect.succeed(occ),
    deleteOccurrences: (scheduleId: string) => {
      const arr = occurrences.get(String(scheduleId)) ?? [];
      occurrences.delete(String(scheduleId));
      if (arr.length > 0) log.push(`delete-occurrences:${scheduleId}`);
      return Effect.succeed(arr.length);
    },
  };
  return {
    repo,
    schedules,
    occurrences,
    failureSlot: {
      get: () => failure,
      set: (f: typeof failure) => {
        failure = f;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture wiring
// ---------------------------------------------------------------------------

function makeHarness() {
  const stores = makeStores();
  const log: string[] = [];
  const clock = { now: () => 1_000 };
  const ids = {
    generate: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  };

  const bots = makeBotRepo(stores, log);
  const conversationRepo = makeConversationRepo(stores, log);
  const conversationService = new ConversationService({
    conversationRepo,
    messageRepo: makeMessageRepo(stores),
    sessionRepo: makeSessionRepo(stores),
    clock,
    ids,
  });
  const runRepo = makeRunRepo(stores, log);
  const sessionRepo = makeSessionRepo(stores);
  const runtime = makeRuntime(log);
  const runService = new RunService({
    runRepo,
    botRepo: bots,
    workspace: makeWorkspace(stores, []),
    runtime,
    clock,
    ids,
  });
  const coordinator = new ConversationRunCoordinator({
    conversationService,
    runService,
    botRepo: bots,
    clock,
  });
  const scheduleHarness = makeScheduleRepoHarness(log);
  const scheduleService = new ScheduleService({
    scheduleRepo: scheduleHarness.repo as never,
    botRepo: bots,
    runService,
    clock,
    ids,
  });
  const activityRepo = makeActivityRepo(stores);
  const fileIndexRepo = makeFileIndexRepo(stores);
  const taskRepo = makeTaskRepo(stores);
  const workspace = makeWorkspace(stores, log);

  const deletion = new BotDeletionService({
    botRepo: bots,
    conversationRepo,
    runRepo,
    sessionRepo,
    taskRepo,
    fileIndex: fileIndexRepo,
    activity: activityRepo,
    workspace,
    runService,
    scheduleService,
    coordinator,
    clock,
    ids,
  });

  return {
    deletion,
    stores,
    log,
    scheduleHarness,
    bots,
    conversationService,
    activityRepo,
  };
}

// Seed a full graph: two bots in one group thread, another private thread,
// second + third bots' own data that must survive.
function seed(stores: Stores, scheduleHarness: ReturnType<typeof makeScheduleRepoHarness>) {
  const bot = (id: string, name: string): Bot => ({
    id: asBotId(id),
    name,
    description: "",
    persona: "",
    status: "active",
    avatar: avatarFromBotId(id),
    createdAt: 1,
    updatedAt: 1,
  });
  stores.bots.set("bot-1", bot("bot-1", "One"));
  stores.bots.set("bot-2", bot("bot-2", "Two"));
  stores.bots.set("bot-3", bot("bot-3", "Three"));

  stores.conversations.set("conv-1", {
    id: asConversationId("conv-1"),
    kind: "team",
    title: "group",
    participants: ["bot-1", "bot-2", "human"],
    createdAt: 1,
    updatedAt: 1,
  } as Conversation);
  stores.conversations.set("conv-2", {
    id: asConversationId("conv-2"),
    kind: "direct",
    title: "private",
    participants: ["bot-1", "human"],
    createdAt: 1,
    updatedAt: 1,
  } as Conversation);
  stores.conversations.set("conv-9", {
    id: asConversationId("conv-9"),
    kind: "direct",
    title: "unrelated",
    participants: ["bot-3", "human"],
    createdAt: 1,
    updatedAt: 1,
  } as Conversation);

  stores.messages.set("m-1", {
    id: asMessageId("m-1"),
    conversationId: asConversationId("conv-1"),
    senderType: "human",
    content: "hi",
    createdAt: 1,
  } as Message);
  stores.messages.set("m-9", {
    id: asMessageId("m-9"),
    conversationId: asConversationId("conv-9"),
    senderType: "human",
    content: "keep",
    createdAt: 1,
  } as Message);

  stores.sessions.set("sess-a", {
    id: asConversationSessionId("sess-a"),
    conversationId: asConversationId("conv-1"),
    runtimeSessionId: "rt-a",
    botId: "bot-1",
    status: "active",
    lastUsedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  stores.sessions.set("sess-b", {
    id: asConversationSessionId("sess-b"),
    conversationId: asConversationId("conv-1"),
    runtimeSessionId: "rt-b",
    botId: "bot-2",
    status: "active",
    lastUsedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  stores.sessions.set("sess-c", {
    id: asConversationSessionId("sess-c"),
    conversationId: asConversationId("conv-2"),
    runtimeSessionId: "rt-c",
    botId: "bot-1",
    status: "active",
    lastUsedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  stores.sessions.set("sess-z", {
    id: asConversationSessionId("sess-z"),
    conversationId: asConversationId("conv-9"),
    runtimeSessionId: "rt-z",
    botId: "bot-3",
    status: "active",
    lastUsedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });

  const run = (
    id: string,
    botId: string,
    conversationId?: string,
    status: Run["status"] = "succeeded",
    taskId?: string,
  ): Run =>
    ({
      id: asRunId(id),
      botId: asBotId(botId),
      triggerType: "manual",
      prompt: "p",
      status,
      ...(conversationId ? { conversationId: asConversationId(conversationId) } : {}),
      ...(taskId ? { taskId } : {}),
      timeoutMs: 1000,
      createdAt: 1,
      updatedAt: 1,
    }) as Run;
  stores.runs.set("run-1", run("run-1", "bot-1"));
  stores.runs.set("run-2", run("run-2", "bot-1", "conv-1", "running"));
  stores.runs.set("run-3", run("run-3", "bot-2", "conv-1"));
  stores.runs.set("run-9", run("run-9", "bot-3", "conv-9"));
  stores.runEvents.set("run-1", [{ _tag: "start" }]);
  stores.runEvents.set("run-3", [{ _tag: "start" }]);

  stores.tasks.set("t-1", {
    id: "t-1",
    requester: null,
    assignee: "bot-1",
    description: "d",
    inputRefs: [],
    priority: 0,
    status: "queued",
    depth: 0,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Task);
  stores.tasks.set("t-2", {
    id: "t-2",
    requester: "bot-1",
    assignee: "bot-2",
    description: "d",
    inputRefs: [],
    priority: 0,
    status: "queued",
    depth: 0,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Task);
  stores.tasks.set("t-9", {
    id: "t-9",
    requester: null,
    assignee: "bot-3",
    description: "d",
    inputRefs: [],
    priority: 0,
    status: "queued",
    depth: 0,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Task);

  stores.fileIndex.set("fi-1", { botId: "bot-1", path: "notes/a.md" });
  stores.fileIndex.set("fi-9", { botId: "bot-3", path: "notes/b.md" });

  scheduleHarness.schedules.set("s-1", {
    id: asScheduleId("s-1"),
    botId: asBotId("bot-1"),
    prompt: "p",
    trigger: { kind: "interval", everyMs: 60_000 },
    enabled: true,
    conversationId: null,
    createdBy: null,
    anchorAt: 1,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  });
  // Created by bot-1 but targeting bot-2 — dies with its creator.
  scheduleHarness.schedules.set("s-2", {
    id: asScheduleId("s-2"),
    botId: asBotId("bot-2"),
    prompt: "p",
    trigger: { kind: "interval", everyMs: 60_000 },
    enabled: true,
    conversationId: null,
    createdBy: "bot-1",
    anchorAt: 1,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  });
  // Bound to a conversation the bot participated in — owned by bot-2 though,
  // so the scheduler re-provisions its thread and it survives.
  scheduleHarness.schedules.set("s-3", {
    id: asScheduleId("s-3"),
    botId: asBotId("bot-2"),
    prompt: "p",
    trigger: { kind: "interval", everyMs: 60_000 },
    enabled: true,
    conversationId: asConversationId("conv-1"),
    createdBy: null,
    anchorAt: 1,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  });
  scheduleHarness.schedules.set("s-9", {
    id: asScheduleId("s-9"),
    botId: asBotId("bot-3"),
    prompt: "p",
    trigger: { kind: "interval", everyMs: 60_000 },
    enabled: true,
    conversationId: null,
    createdBy: null,
    anchorAt: 1,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  });
  scheduleHarness.occurrences.set("s-1", [
    {
      id: asScheduleOccurrenceId("occ-1"),
      scheduleId: asScheduleId("s-1"),
      scheduledFor: 1,
      status: "pending",
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ]);

  const act = (id: string, entityType: string, entityId: string): ActivityEvent => ({
    id: asActivityId(id),
    type: "event",
    entityType,
    entityId,
    actorId: null,
    payload: null,
    createdAt: 1,
  });
  stores.activity.set("a-1", act("a-1", "bot", "bot-1"));
  stores.activity.set("a-2", act("a-2", "conversation", "conv-1"));
  stores.activity.set("a-3", act("a-3", "schedule", "s-1"));
  stores.activity.set("a-4", act("a-4", "bot", "bot-3"));
}

describe("BotDeletionService.deleteBot", () => {
  it("cascades everything the bot owns or participates in", async () => {
    const h = makeHarness();
    seed(h.stores, h.scheduleHarness);

    await Effect.runPromise(h.deletion.deleteBot(asBotId("bot-1")));

    // Bot and its conversations are gone (conv-1 is a group thread).
    expect(h.stores.bots.has("bot-1")).toBe(false);
    expect(h.stores.bots.has("bot-2")).toBe(true);
    expect(h.stores.bots.has("bot-3")).toBe(true);
    expect(h.stores.conversations.has("conv-1")).toBe(false);
    expect(h.stores.conversations.has("conv-2")).toBe(false);
    expect(h.stores.conversations.has("conv-9")).toBe(true);

    // Messages: only the unrelated thread's message survives.
    expect(h.stores.messages.has("m-1")).toBe(false);
    expect(h.stores.messages.has("m-9")).toBe(true);

    // Sessions: every session of the deleted conversations plus every
    // bot-1-scoped session is gone; other bots' unrelated sessions stay.
    expect(h.stores.sessions.has("sess-a")).toBe(false);
    expect(h.stores.sessions.has("sess-b")).toBe(false);
    expect(h.stores.sessions.has("sess-c")).toBe(false);
    expect(h.stores.sessions.has("sess-z")).toBe(true);

    // Runs: bot-1's runs and runs inside its conversations (bot-2's run-3)
    // are gone with their events; unrelated runs stay.
    expect(h.stores.runs.has("run-1")).toBe(false);
    expect(h.stores.runs.has("run-2")).toBe(false);
    expect(h.stores.runs.has("run-3")).toBe(false);
    expect(h.stores.runEvents.has("run-1")).toBe(false);
    expect(h.stores.runEvents.has("run-3")).toBe(false);
    expect(h.stores.runs.has("run-9")).toBe(true);

    // Tasks requested by or assigned to the bot are gone.
    expect(h.stores.tasks.has("t-1")).toBe(false);
    expect(h.stores.tasks.has("t-2")).toBe(false);
    expect(h.stores.tasks.has("t-9")).toBe(true);

    // Schedules: owned and created-by both deleted with their occurrences; a
    // schedule of another bot merely bound to the deleted conversation
    // survives (the scheduler re-provisions its vanished thread).
    expect(h.scheduleHarness.schedules.has("s-1")).toBe(false);
    expect(h.scheduleHarness.schedules.has("s-2")).toBe(false);
    expect(h.scheduleHarness.schedules.has("s-3")).toBe(true);
    expect(h.scheduleHarness.schedules.has("s-9")).toBe(true);
    expect(h.scheduleHarness.occurrences.has("s-1")).toBe(false);

    // File index rows: bot-1's cleared, other bots' remain.
    expect([...h.stores.fileIndex.values()].some((e) => e.botId === "bot-1")).toBe(false);
    expect([...h.stores.fileIndex.values()].some((e) => e.botId === "bot-3")).toBe(true);

    // Activity events referencing deleted entities are cleared; unrelated stay.
    expect(h.stores.activity.has("a-1")).toBe(false);
    expect(h.stores.activity.has("a-2")).toBe(false);
    expect(h.stores.activity.has("a-3")).toBe(false);
    expect(h.stores.activity.has("a-4")).toBe(true);

    // Workspace home removed exactly once, for this bot.
    expect(h.log.filter((l) => l.startsWith("remove-home:"))).toEqual(["remove-home:bot-1"]);

    // The deletion itself is recorded.
    const deletedEvents = [...h.stores.activity.values()].filter((e) => e.type === "bot.deleted");
    expect(deletedEvents).toHaveLength(1);
    expect(deletedEvents[0]?.entityId).toBe("bot-1");
  });

  it("cancels live runs before deleting their rows", async () => {
    const h = makeHarness();
    seed(h.stores, h.scheduleHarness);
    await Effect.runPromise(h.deletion.deleteBot(asBotId("bot-1")));
    const runDeletes = h.log.flatMap((entry, i) => (entry.startsWith("delete-runs-") ? [i] : []));
    expect(runDeletes.length).toBeGreaterThan(0);
    // run-2 was running and belongs to the deleted bot: it must be cancelled
    // in the run store before any run-row deletion.
    const cancels = h.log.filter((l) => l.startsWith("cancel-run:"));
    expect(cancels).toEqual(["cancel-run:run-2"]);
    const cancelIndex = h.log.findIndex((l) => l.startsWith("cancel-run:"));
    expect(cancelIndex).toBeLessThan(Math.min(...runDeletes));
  });

  it("orders the cascade: schedules, per-thread purges, bot sweeps, workspace, bot row", async () => {
    const h = makeHarness();
    seed(h.stores, h.scheduleHarness);
    await Effect.runPromise(h.deletion.deleteBot(asBotId("bot-1")));

    const indexOf = (prefix: string) => h.log.findIndex((l) => l.startsWith(prefix));
    const firstSchedule = indexOf("delete-schedule:");
    const cancel = indexOf("cancel-run:");
    const threadRunPurge = indexOf("delete-runs-conversation:conv-1");
    const firstConversation = indexOf("delete-conversation:");
    const botRunSweep = indexOf("delete-runs-bot:");
    const workspace = indexOf("remove-home:");
    const botRow = indexOf("delete-bot:");
    expect(firstSchedule).toBeGreaterThanOrEqual(0);
    // The live run is cancelled before any run row disappears.
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeLessThan(threadRunPurge);
    // Within a thread: run rows and messages go before the conversation row.
    expect(threadRunPurge).toBeLessThan(firstConversation);
    // The bot-wide sweeps (safety net) come after the per-thread cascades.
    expect(firstConversation).toBeLessThan(botRunSweep);
    // The workspace and finally the bot row: an interrupted delete leaves the
    // bot row present, so the operation can be retried.
    expect(botRunSweep).toBeLessThan(workspace);
    expect(workspace).toBeLessThan(botRow);
  });

  it("fails NotFound and touches nothing when the bot is missing", async () => {
    const h = makeHarness();
    seed(h.stores, h.scheduleHarness);
    const before = h.log.length;
    const exit = await Effect.runPromiseExit(h.deletion.deleteBot(asBotId("ghost")));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Error);
      expect(String(Cause.squash(exit.cause))).toContain("ghost");
    }
    expect(h.log.slice(before)).toEqual([]);
    expect(h.stores.bots.size).toBe(3);
  });

  it("keeps deleting when an individual schedule deletion fails", async () => {
    const h = makeHarness();
    seed(h.stores, h.scheduleHarness);
    h.scheduleHarness.failureSlot.set({ id: "s-1", error: new Error("db exploded") });

    await Effect.runPromise(h.deletion.deleteBot(asBotId("bot-1")));

    // The bot itself and everything else still went through.
    expect(h.stores.bots.has("bot-1")).toBe(false);
    expect(h.stores.conversations.has("conv-1")).toBe(false);
    // The failing schedule (and only it) remains, retryable.
    expect(h.scheduleHarness.schedules.has("s-1")).toBe(true);
    expect(h.scheduleHarness.schedules.has("s-2")).toBe(false);
  });

  it("still records bot.deleted when the audit write fails", async () => {
    const h = makeHarness();
    seed(h.stores, h.scheduleHarness);
    h.activityRepo.create = () => Effect.fail(new Error("audit down")) as never;
    const exit = await Effect.runPromiseExit(h.deletion.deleteBot(asBotId("bot-1")));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(h.stores.bots.has("bot-1")).toBe(false);
  });
});
