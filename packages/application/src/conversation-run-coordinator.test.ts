import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Stream } from "effect";
import type { Bot, Conversation, ConversationSession, Message, Run } from "@bebots/domain";
import { asBotId, asConversationId, avatarFromBotId } from "@bebots/domain";
import { BOT_LINK_PIN_TTL_MS, ConversationRunCoordinator } from "./conversation-run-coordinator.js";
import { ConversationService, ConversationSessionService } from "./conversation-service.js";
import { NotFoundError } from "./errors.js";
import { RunService } from "./run-service.js";
import type {
  BotRepository,
  BotWorkspace,
  Clock,
  ConversationRepository,
  ConversationSessionRepository,
  IdGenerator,
  MessageRepository,
  RunRepository,
} from "./repositories.js";
import type { AgentRuntime, RuntimeError, RunHandle, RunRequest, RuntimeEvent } from "./runtime.js";

// ---------------------------------------------------------------------------
// In-memory fakes (mirrors the repository contracts exactly)
// ---------------------------------------------------------------------------

function makeConversationRepo(): ConversationRepository {
  const store = new Map<string, Conversation>();
  return {
    create: (c) => {
      store.set(String(c.id), c);
      return Effect.succeed(c);
    },
    findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
    findAll: () => Effect.succeed([...store.values()]),
    update: (c) => Effect.succeed(c),
    delete: (id) => {
      store.delete(String(id));
      return Effect.void;
    },
  };
}

function makeMessageRepo(): MessageRepository {
  const store = new Map<string, Message>();
  return {
    create: (m) => {
      store.set(String(m.id), m);
      return Effect.succeed(m);
    },
    findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
    findByConversation: (conversationId, options) => {
      const list = [...store.values()]
        .filter((m) => String(m.conversationId) === String(conversationId))
        .sort((a, b) => a.createdAt - b.createdAt);
      return Effect.succeed(options?.limit !== undefined ? list.slice(0, options.limit) : list);
    },
    findAll: () => Effect.succeed([...store.values()]),
    update: (m) => Effect.succeed(m),
    deleteByConversation: (conversationId) => {
      let removed = 0;
      for (const [id, m] of [...store]) {
        if (String(m.conversationId) === String(conversationId)) {
          store.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    delete: (id) => {
      store.delete(String(id));
      return Effect.void;
    },
  };
}

function makeSessionRepo(): ConversationSessionRepository {
  const sessions = new Map<string, ConversationSession>();
  return {
    create: (s) => {
      sessions.set(String(s.id), s);
      return Effect.succeed(s);
    },
    findById: (id) => Effect.succeed(sessions.get(String(id)) ?? null),
    findLatestByConversation: (conversationId, options) =>
      Effect.succeed(
        [...sessions.values()]
          .filter(
            (s) =>
              String(s.conversationId) === String(conversationId) &&
              (!options?.status || s.status === options.status),
          )
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null,
      ),
    findAll: (filter) =>
      Effect.succeed(
        [...sessions.values()].filter((s) => !filter?.status || s.status === filter.status),
      ),
    update: (s) => Effect.succeed(s),
    deleteByConversation: (conversationId) => {
      let removed = 0;
      for (const [id, s] of [...sessions]) {
        if (String(s.conversationId) === String(conversationId)) {
          sessions.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    deleteByBot: (botId) => {
      let removed = 0;
      for (const [id, s] of [...sessions]) {
        if (s.botId !== null && String(s.botId) === String(botId)) {
          sessions.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    delete: (id) => {
      sessions.delete(String(id));
      return Effect.void;
    },
  };
}

const bot: Bot = {
  id: asBotId("bot-1"),
  name: "Bot One",
  description: "",
  persona: "",
  status: "active",
  avatar: avatarFromBotId("bot-1"),
  createdAt: 1,
  updatedAt: 1,
};

const botRepo: BotRepository = {
  create: (b) => Effect.succeed(b),
  findById: (id) => Effect.succeed(String(id) === "bot-1" ? bot : null),
  findAll: () => Effect.succeed([bot]),
  update: (b) => Effect.succeed(b),
  delete: () => Effect.void,
};

const workspace: BotWorkspace = {
  root: "/tmp/bots",
  ensureHome: () => Effect.succeed("/tmp/bots"),
  writePersona: () => Effect.void,
  homePath: () => "/tmp/bots/bot-1",
  removeHome: () => Effect.void,
      storeReceivedFile: () => Effect.succeed({ savedName: "file", size: 0 }),
      readReceivedFile: () => Effect.succeed(null),
      removeReceivedFile: () => Effect.succeed(false),
      removeReceivedConversationDir: () => Effect.void,
};

function makeRunRepo(): {
  readonly repo: RunRepository;
  readonly store: Map<string, Run>;
  readonly events: Map<string, unknown[]>;
} {
  const store = new Map<string, Run>();
  const events = new Map<string, unknown[]>();
  const repo: RunRepository = {
    create: (run) => {
      store.set(String(run.id), run);
      return Effect.succeed(run);
    },
    findById: (id) => Effect.succeed(store.get(String(id)) ?? null),
    findAll: (options) =>
      Effect.succeed(
        [...store.values()].filter(
          (r) =>
            (!options?.botId || String(r.botId) === String(options.botId)) &&
            (!options?.status || r.status === options.status) &&
            (!options?.conversationId ||
              (r.conversationId !== undefined &&
                String(r.conversationId) === String(options.conversationId))),
        ),
      ),
    update: (run) => {
      store.set(String(run.id), run);
      return Effect.succeed(run);
    },
    appendEvent: (runId, event) => {
      const arr = events.get(String(runId)) ?? [];
      arr.push(event);
      events.set(String(runId), arr);
      return Effect.void;
    },
    listEvents: () => Effect.succeed([]),
    deleteByBot: (botId) => {
      let removed = 0;
      for (const [id, run] of [...store]) {
        if (String(run.botId) === String(botId)) {
          store.delete(id);
          events.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
    deleteByConversation: (conversationId) => {
      let removed = 0;
      for (const [id, run] of [...store]) {
        if (
          run.conversationId !== undefined &&
          String(run.conversationId) === String(conversationId)
        ) {
          store.delete(id);
          events.delete(id);
          removed++;
        }
      }
      return Effect.succeed(removed);
    },
  };
  return { repo, store, events };
}

function makeRuntime(overrides: Partial<Pick<AgentRuntime, "startRun">> = {}): AgentRuntime {
  const runtime: AgentRuntime = {
    id: "fake",
    capabilities: { streaming: false, resumableSessions: false, cancellation: false },
    startRun: (_request: RunRequest) =>
      Effect.succeed({ runId: "rt-1", sessionId: "sess-1" } satisfies RunHandle),
    cancelRun: () => Effect.void,
    streamEvents: () => Stream.fromIterable<RuntimeEvent>([{ _tag: "completed", summary: "done" }]),
    getResult: () => Effect.succeed({ exitCode: 0, summary: "done" }),
  };
  return { ...runtime, ...overrides };
}

interface TestEnv {
  readonly coordinator: ConversationRunCoordinator;
  readonly conversationService: ConversationService;
  readonly sessions: ConversationSessionService;
  /** The run rows the env's RunService persists, for purge assertions. */
  readonly runStore: Map<string, Run>;
}

/** `participantBots` controls which participants the fake bot repo knows. */
function makeEnv(
  participants: readonly string[],
  runtime: AgentRuntime,
  options: { ids?: IdGenerator; clock?: Clock; botLedger?: BotRepository } = {},
): TestEnv {
  const fixedClock: Clock = options.clock ?? { now: () => 1_000 };
  const ids: IdGenerator = options.ids ?? { generate: () => "fixed-id" };
  const conversationService = new ConversationService({
    conversationRepo: makeConversationRepo(),
    messageRepo: makeMessageRepo(),
    clock: fixedClock,
    ids,
  });
  const sessions = new ConversationSessionService({
    sessionRepo: makeSessionRepo(),
    clock: fixedClock,
    ids,
  });
  const runRepo = makeRunRepo();
  const runService = new RunService({
    runRepo: runRepo.repo,
    botRepo: options.botLedger ?? botRepo,
    workspace,
    runtime,
    clock: fixedClock,
    ids,
    conversationSessions: sessions,
  });
  const coordinator = new ConversationRunCoordinator({
    conversationService,
    runService,
    botRepo: options.botLedger ?? botRepo,
    clock: fixedClock,
  });
  return { coordinator, conversationService, sessions, runStore: runRepo.store };
}

async function seedConversation(env: TestEnv, participants: readonly string[]): Promise<void> {
  await Effect.runPromise(
    env.conversationService.createConversation({ title: "thread", participants }),
  );
}

// The seeded conversation id: ids.generate() is fixed in this environment.
const conversationId = "fixed-id";

describe("ConversationRunCoordinator", () => {
  it("triggers a participant-bot run on a human message and links it", async () => {
    const env = makeEnv(["bot-1", "human"], makeRuntime());
    await seedConversation(env, ["bot-1", "human"]);

    const result = await Effect.runPromise(
      env.coordinator.sendMessage({ conversationId, content: "hello bot" }),
    );

    expect(result.message.content).toBe("hello bot");
    expect(result.run).not.toBeNull();
    expect(result.run?.botId).toBe("bot-1");
    expect(result.run?.conversationId).toBe(asConversationId(conversationId));
    expect(result.run?.triggerType).toBe("message");
    expect(result.run?.prompt).toBe("hello bot");
    // The reply run's session was captured for later resumption (issue #15).
    const sessionList = await Effect.runPromise(env.sessions.listSessions({ conversationId }));
    expect(sessionList[0]?.runtimeSessionId).toBe("sess-1");
  });

  it("does not trigger for bot or system messages", async () => {
    for (const senderType of ["bot", "system"] as const) {
      const env = makeEnv(["bot-1", "human"], makeRuntime());
      await seedConversation(env, ["bot-1", "human"]);
      const result = await Effect.runPromise(
        env.coordinator.sendMessage({ conversationId, content: "onward", senderType }),
      );
      expect(result.run).toBeNull();
      expect(result.message.senderType).toBe(senderType);
    }
  });

  it("stores a message without triggering when no bot participates", async () => {
    const env = makeEnv([], makeRuntime());
    await seedConversation(env, ["human"]);
    const result = await Effect.runPromise(
      env.coordinator.sendMessage({ conversationId, content: "just us" }),
    );
    expect(result.run).toBeNull();
  });

  it("fails typed when the conversation does not exist", async () => {
    const env = makeEnv(["bot-1", "human"], makeRuntime());
    const exit = await Effect.runPromiseExit(
      env.coordinator.sendMessage({ conversationId: "missing", content: "hi" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(NotFoundError);
    }
  });

  it("keeps the message delivered when the reply run cannot start", async () => {
    const failing: RuntimeError = { _tag: "RuntimeError", message: "boom" };
    const env = makeEnv(["bot-1", "human"], makeRuntime({ startRun: () => Effect.fail(failing) }));
    await seedConversation(env, ["bot-1", "human"]);
    const result = await Effect.runPromise(
      env.coordinator.sendMessage({ conversationId, content: "hello" }),
    );
    expect(result.message.content).toBe("hello");
    expect(result.run).toBeNull();
  });
});

describe("ConversationRunCoordinator.recordBotReply", () => {
  it("persists the run summary as a bot reply from the run's bot", async () => {
    const env = makeEnv([], makeRuntime());
    await seedConversation(env, []);
    await Effect.runPromise(env.coordinator.recordBotReply(conversationId, "bot-1", "the answer"));
    const thread = await Effect.runPromise(env.conversationService.listMessages(conversationId));
    expect(thread).toHaveLength(1);
    expect(thread[0]?.senderType).toBe("bot");
    expect(thread[0]?.senderId).toBe("bot-1");
    expect(thread[0]?.content).toBe("the answer");
  });

  it("drops replies into conversations that no longer exist (deleted during the run)", async () => {
    const env = makeEnv([], makeRuntime());
    // No conversation was ever created (e.g. deleted while the run was in
    // flight): the reply must not resurrect orphaned message rows.
    await Effect.runPromise(env.coordinator.recordBotReply(conversationId, "bot-1", "late answer"));
    const thread = await Effect.runPromise(env.conversationService.listMessages(conversationId));
    expect(thread).toHaveLength(0);
  });
});

describe("ConversationRunCoordinator.recordSystemMarker", () => {
  it("persists a system marker into the thread", async () => {
    const env = makeEnv([], makeRuntime());
    await seedConversation(env, []);
    await Effect.runPromise(
      env.coordinator.recordSystemMarker(
        conversationId,
        '{"kind":"ask-answer","question":"Q?","answer":"A"}',
      ),
    );
    const thread = await Effect.runPromise(env.conversationService.listMessages(conversationId));
    expect(thread).toHaveLength(1);
    expect(thread[0]?.senderType).toBe("system");
    expect(thread[0]?.content).toContain("ask-answer");
  });
});

describe("ConversationRunCoordinator.deleteConversation", () => {
  it("purges messages, runs and the conversation, then rejects further sends", async () => {
    const env = makeEnv([], makeRuntime());
    await seedConversation(env, ["bot-1", "human"]);
    const sent = await Effect.runPromise(
      env.coordinator.sendMessage({ conversationId, content: "hello", senderType: "human" }),
    );
    expect(sent.run).not.toBeNull();
    // The run row references the thread before deletion.
    expect([...env.runStore.keys()]).toHaveLength(1);

    await Effect.runPromise(env.coordinator.deleteConversation(conversationId));

    const thread = await Effect.runPromise(env.conversationService.listMessages(conversationId));
    expect(thread).toHaveLength(0);
    // The thread's run rows (and their events) died with it.
    expect([...env.runStore.keys()]).toHaveLength(0);
    const exit = await Effect.runPromiseExit(
      env.coordinator.sendMessage({ conversationId, content: "anyone there?" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(NotFoundError);
    }
  });

  it("fails NotFound when the conversation does not exist", async () => {
    const env = makeEnv([], makeRuntime());
    const exit = await Effect.runPromiseExit(env.coordinator.deleteConversation("missing"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(NotFoundError);
    }
  });
});

describe("duplicate reply runs", () => {
  const secondBot: Bot = { ...bot, id: asBotId("bot-2"), name: "Bot Two" };
  const twoBotRepo: BotRepository = {
    create: (b) => Effect.succeed(b),
    findById: (id) => {
      const key = String(id);
      return Effect.succeed(key === "bot-1" ? bot : key === "bot-2" ? secondBot : null);
    },
    findAll: () => Effect.succeed([bot, secondBot]),
    update: (b) => Effect.succeed(b),
    delete: () => Effect.void,
  };

  it("a human message that explicitly mentions another bot still triggers the participant bot", async () => {
    const started: RunRequest[] = [];
    const runtime = makeRuntime({
      startRun: (request: RunRequest) => {
        started.push(request);
        return Effect.succeed({
          runId: `rt-${started.length}`,
          sessionId: "sess-1",
        } satisfies RunHandle);
      },
    });
    const fixedClock: Clock = { now: () => 1_000 };
    const ids: IdGenerator = { generate: () => "fixed-id" };
    const conversationService = new ConversationService({
      conversationRepo: makeConversationRepo(),
      messageRepo: makeMessageRepo(),
      clock: fixedClock,
      ids,
    });
    const runService = new RunService({
      runRepo: makeRunRepo().repo,
      botRepo: twoBotRepo,
      workspace,
      runtime,
      clock: fixedClock,
      ids,
    });
    const coordinator = new ConversationRunCoordinator({
      conversationService,
      runService,
      botRepo: twoBotRepo,
    });

    const created = await Effect.runPromise(
      conversationService.createConversation({ title: "thread", participants: ["bot-1", "human"] }),
    );
    const conversationId = String(created.id);

    // The user's real scenario: a message written in one bot's thread that
    // @-mentions another bot stays with the thread's participant bot — the
    // participant then contacts the mentioned bot itself via send_message.
    // Starting a second run for the mentioned bot delivered the reply twice.
    await Effect.runPromise(
      coordinator.sendMessage({
        conversationId,
        content: "Ask @bot-2 what the company name is",
        senderType: "human",
      }),
    );
    // Give the instant-completing fake runtime a beat to settle any follow-up
    // triggering from recorded replies.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(started.map((r) => String(r.botId))).toEqual(["bot-1"]);
  });
});

describe("bot-to-bot send_message continuity (bot-link pins)", () => {
  function makeNamedBot(id: string, name: string): Bot {
    return {
      id: asBotId(id),
      name,
      description: "",
      persona: "",
      status: "active",
      avatar: avatarFromBotId(id),
      createdAt: 1,
      updatedAt: 1,
    };
  }

  function makeBotLedger(bots: readonly Bot[]): BotRepository {
    const byId = new Map(bots.map((b) => [String(b.id), b] as const));
    return {
      create: (b) => Effect.succeed(b),
      findById: (id) => Effect.succeed(byId.get(String(id)) ?? null),
      findAll: () => Effect.succeed([...byId.values()]),
      update: (b) => Effect.succeed(b),
      delete: () => Effect.void,
    };
  }

  function makeSeqIds(): IdGenerator {
    let counter = 0;
    return { generate: () => `id-${++counter}` };
  }

  const bot2 = makeNamedBot("bot-2", "Bot Two");
  const bot3 = makeNamedBot("bot-3", "Bot Three");

  async function pin(env: TestEnv, callerBotId: string, targetBotId: string): Promise<string> {
    return Effect.runPromise(
      env.coordinator.resolveBotLinkConversation({ callerBotId, targetBotId }),
    );
  }

  it("routes a caller's repeated sends to one bot through the same pinned conversation", async () => {
    const env = makeEnv(["bot-1", "bot-2"], makeRuntime(), {
      ids: makeSeqIds(),
      botLedger: makeBotLedger([bot, bot2]),
    });
    const first = await pin(env, "bot-1", "bot-2");
    const second = await pin(env, "bot-1", "bot-2");
    expect(second).toBe(first);

    // The pin is scoped to the (caller, target) pair: another caller to the
    // same target gets its own conversation.
    const otherCaller = await pin(env, "bot-2", "bot-1");
    expect(otherCaller).not.toBe(first);

    // An explicit conversation id always wins.
    await Effect.runPromise(
      env.conversationService.createConversation({
        title: "explicit",
        participants: ["bot-1", "bot-2"],
      }),
    );
    const provided = "id-explicit";
    const explicit = await Effect.runPromise(
      env.coordinator.resolveBotLinkConversation({
        callerBotId: "bot-1",
        targetBotId: "bot-2",
        conversationId: provided,
      }),
    );
    expect(explicit).toBe(provided);
  });

  it("the recipient's conversation session is created once and resumed for follow-up messages", async () => {
    const started: RunRequest[] = [];
    const runtime = makeRuntime({
      startRun: (request: RunRequest) => {
        started.push(request);
        return Effect.succeed({
          runId: `rt-${started.length}`,
          sessionId: "sess-1",
        } satisfies RunHandle);
      },
    });
    const env = makeEnv(["bot-1", "bot-2"], runtime, {
      ids: makeSeqIds(),
      botLedger: makeBotLedger([bot, bot2]),
    });
    const conversationId = await pin(env, "bot-1", "bot-2");

    await Effect.runPromise(
      env.coordinator.sendMessage({
        conversationId,
        content: "hello",
        senderType: "bot",
        senderId: "bot-1",
      }),
    );
    await Effect.runPromise(
      env.coordinator.sendMessage({
        conversationId,
        content: "follow-up?",
        senderType: "bot",
        senderId: "bot-1",
      }),
    );

    expect(started).toHaveLength(2);
    expect(String(started[1]?.prompt)).toBe("follow-up?");
    // First send had no stored session to resume; the follow-up resumed the
    // session recorded by the first send — the same recipient session.
    expect(started[0]?.sessionId).toBeUndefined();
    expect(started[1]?.sessionId).toBe("sess-1");
    const sessionList = await Effect.runPromise(env.sessions.listSessions({ conversationId }));
    expect(sessionList).toHaveLength(1);
    expect(sessionList[0]?.botId).toBe("bot-2");
  });

  it("releases the caller's pins when the caller records its own reply, but not other callers' pins", async () => {
    const env = makeEnv(["bot-1", "bot-2"], makeRuntime(), {
      ids: makeSeqIds(),
      botLedger: makeBotLedger([bot, bot2]),
    });
    const pinned = await pin(env, "bot-1", "bot-2");
    const bot2Pin = await pin(env, "bot-2", "bot-1");

    await Effect.runPromise(
      env.coordinator.recordBotReply(pinned, "bot-1", "the answer for the user"),
    );

    const repinned = await pin(env, "bot-1", "bot-2");
    expect(repinned).not.toBe(pinned);
    expect(await pin(env, "bot-2", "bot-1")).toBe(bot2Pin);
  });

  it("expires bot-link pins after the sliding inactivity window", async () => {
    let now = 1_000;
    const env = makeEnv(["bot-1", "bot-2"], makeRuntime(), {
      ids: makeSeqIds(),
      clock: { now: () => now },
      botLedger: makeBotLedger([bot, bot2]),
    });
    const pinned = await pin(env, "bot-1", "bot-2");
    now += 5 * 60 * 1000; // still within the window, sliding
    expect(await pin(env, "bot-1", "bot-2")).toBe(pinned);
    now += BOT_LINK_PIN_TTL_MS + 1;
    expect(await pin(env, "bot-1", "bot-2")).not.toBe(pinned);
  });

  it("does not re-trigger the pinned caller when the target's reply lands in the link conversation", async () => {
    const started: RunRequest[] = [];
    const runtime = makeRuntime({
      startRun: (request: RunRequest) => {
        started.push(request);
        return Effect.succeed({
          runId: `rt-${started.length}`,
          sessionId: "sess-1",
        } satisfies RunHandle);
      },
    });
    const env = makeEnv(["bot-1", "bot-2"], runtime, {
      ids: makeSeqIds(),
      botLedger: makeBotLedger([bot, bot2]),
    });
    const conversationId = await pin(env, "bot-1", "bot-2");

    await Effect.runPromise(
      env.coordinator.recordBotReply(conversationId, "bot-2", "worked on it"),
    );

    // bot-1 (the pinned caller) receives the reply synchronously via
    // send_message; propagating it would only re-trigger bot-1 redundantly.
    expect(started).toHaveLength(0);
    const thread = await Effect.runPromise(env.conversationService.listMessages(conversationId));
    expect(thread).toHaveLength(1);
    expect(thread[0]?.senderId).toBe("bot-2");
  });

  it("still relays @mentions to other bots inside a bot-link conversation", async () => {
    const started: RunRequest[] = [];
    const runtime = makeRuntime({
      startRun: (request: RunRequest) => {
        started.push(request);
        return Effect.succeed({
          runId: `rt-${started.length}`,
          sessionId: "sess-1",
        } satisfies RunHandle);
      },
    });
    const env = makeEnv(["bot-1", "bot-2"], runtime, {
      ids: makeSeqIds(),
      botLedger: makeBotLedger([bot, bot2, bot3]),
    });
    const conversationId = await pin(env, "bot-1", "bot-2");

    await Effect.runPromise(
      env.coordinator.recordBotReply(conversationId, "bot-2", "asking @bot-3"),
    );

    expect(started.map((r) => String(r.botId))).toEqual(["bot-3"]);
  });
});
