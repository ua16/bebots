import { app, BrowserWindow, ipcMain, session } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Effect, Layer } from "effect";
import {
  openDatabase,
  migrate,
  createSqliteBotRepository,
  createSqliteRunRepository,
  createSqliteConversationRepository,
  createSqliteMessageRepository,
  createSqliteConversationSessionRepository,
  createSqliteFileIndexRepository,
  createSqliteTaskRepository,
  createSqliteScheduleRepository,
  createSqliteActivityRepository,
  createSqliteSettingsRepository,
} from "@bebots/persistence";
import {
  AppSettingsService,
  BotService,
  RunService,
  ConversationService,
  ConversationSessionService,
  ConversationRunCoordinator,
  TaskService,
  ScheduleService,
  ActivityService,
} from "@bebots/application";
import type { AgentRuntime } from "@bebots/application";
import type { ConversationReplyRecorder } from "@bebots/application";
import type {
  BotId,
  RunStatus,
  TaskStatus,
  ScheduleId,
} from "@bebots/domain";
import {
  asBotId,
  asRunId,
} from "@bebots/domain";
import { OpenCodeRuntime } from "@bebots/runtime-opencode";
import { makeRoutes } from "@bebots/api";
import { createNodeBotWorkspace, createWorkspaceIndexer } from "./workspace";
import type { WorkspaceIndexer } from "./workspace";
import { HttpRouter, HttpServer } from "effect/http";
import { createMcpServer } from "./mcp";

const isDev = !app.isPackaged;

if (isDev) {
  app.commandLine?.appendSwitch("no-sandbox");
  app.commandLine?.appendSwitch("disable-gpu");
  app.commandLine?.appendSwitch("disable-software-rasterizer");
}

let closeDb: (() => void) | null = null;
let closeServer: (() => void) | null = null;
let _httpServer: ReturnType<typeof createServer> | null = null;
let runtimeInstance: (AgentRuntime & { close(): void }) | null = null;
let indexerInstance: WorkspaceIndexer | null = null;
let sessionSweepInterval: ReturnType<typeof setInterval> | null = null;
let scheduleTickInterval: ReturnType<typeof setInterval> | null = null;
let apiEndpoint: { url: string; token: string } | null = null;
let apiPort: number | null = null;
let mcpHandle: { handleRequest: (req: Request) => Promise<Response> } | null = null;

// Pretty-prints a JSON body for --show-mcp-logs; returns raw text if not JSON,
// truncated to MAX_MCP_LOG_BYTES either way so huge payloads can't flood logs.
const MAX_MCP_LOG_BYTES = 8_000;
function formatMcpJson(text: string): string {
  let out: string;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    out = text;
  }
  if (out.length > MAX_MCP_LOG_BYTES) {
    out = `${out.slice(0, MAX_MCP_LOG_BYTES)}… (${out.length - MAX_MCP_LOG_BYTES} bytes truncated)`;
  }
  return out || "(empty)";
}

/** Scheduler tick cadence; overridable via `BEBOTS_SCHEDULE_TICK_MS` (tests). */
function scheduleTickMs(): number {
  const raw = Number(process.env.BEBOTS_SCHEDULE_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/** Run an Effect task but never let a background routine take the app down. */
function runLogged(effect: Effect.Effect<unknown, unknown>): void {
  Effect.runPromise(effect).catch((cause) =>
    console.error("Background task failed", cause instanceof Error ? cause.message : cause),
  );
}

async function setupBotService(): Promise<void> {
  if (typeof app.getPath !== "function") return;
  const userData = app.getPath("userData");
  const db = await openDatabase(join(userData, "app.sqlite"));
  migrate(db);
  const repo = createSqliteBotRepository(db);
  const runRepo = createSqliteRunRepository(db);
  // Reconcile stale running runs from previous crash/restart.
  const stale = await Effect.runPromise(runRepo.findAll({ status: "running" }));
  for (const r of stale) {
    await Effect.runPromise(
      runRepo.update({
        ...r,
        status: "failed",
        error: "Application restarted during run",
        endedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }
  // Runs persisted as queued but never started (crash between enqueue and
  // launch) get the same reconciliation; their schedule occurrences then
  // resolve through the scheduler's stale-occurrence recovery.
  const staleQueued = await Effect.runPromise(runRepo.findAll({ status: "queued" }));
  for (const r of staleQueued) {
    await Effect.runPromise(
      runRepo.update({
        ...r,
        status: "failed",
        error: "Application restarted before the run started",
        endedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }
  const workspace = createNodeBotWorkspace({ root: userData });
  const settingsRepo = createSqliteSettingsRepository(db);
  const settingsService = new AppSettingsService(settingsRepo);

  const conversationRepo = createSqliteConversationRepository(db);
  const messageRepo = createSqliteMessageRepository(db);
  const conversationSessionRepo = createSqliteConversationSessionRepository(db);
  const fileIndexRepo = createSqliteFileIndexRepository(db);
  const taskRepo = createSqliteTaskRepository(db);
  const activityRepo = createSqliteActivityRepository(db);

  const conversationService = new ConversationService({
    conversationRepo,
    messageRepo,
    clock: { now: () => Date.now() },
    ids: { generate: () => randomUUID() },
  });
  const conversationSessionService = new ConversationSessionService({
    sessionRepo: conversationSessionRepo,
    clock: { now: () => Date.now() },
    ids: { generate: () => randomUUID() },
  });

  // PLAN §5: the workspace service owns the filesystem watcher that indexes
  // direct writes; index storage lives in the file_index repository.
  const indexer = createWorkspaceIndexer({ workspace, fileIndexRepo });
  indexerInstance = indexer;
  indexer.begin();

  const service = new BotService({
    repo,
    workspace,
    clock: { now: () => Date.now() },
    ids: { generate: () => randomUUID() },
  });
  const extraLogs =
    process.argv.includes("--show-extra-logs") ||
    process.env.SHOW_EXTRA_LOGS === "1" ||
    process.env.SHOW_EXTRA_LOGS === "true";
  const showMcpLogs =
    process.argv.includes("--show-mcp-logs") ||
    process.env.SHOW_MCP_LOGS === "1" ||
    process.env.SHOW_MCP_LOGS === "true";
  const showSchedulingLogs =
    process.argv.includes("--show-scheduling-logs") ||
    process.env.SHOW_SCHEDULING_LOGS === "1" ||
    process.env.SHOW_SCHEDULING_LOGS === "true";
  const runtime = new OpenCodeRuntime({ extraLogs });
  runtimeInstance = runtime;
  // Run finalization posts completed conversation runs into the thread as bot
  // replies through the coordinator (declared just below) — PLAN §12 M3:
  // regardless of which path started the run. The annotated recordBotReply
  // closure resolves the coordinator after construction, so the two services
  // can reference each other without a mutable setter.
  const conversationReplyRecorder: ConversationReplyRecorder = {
    recordBotReply: (conversationId, botId, content) =>
      conversationCoordinator.recordBotReply(conversationId, botId, content),
  };
  const runService = new RunService({
    runRepo,
    botRepo: repo,
    workspace,
    runtime,
    clock: { now: () => Date.now() },
    ids: { generate: () => randomUUID() },
    // PLAN §6.4: resume the stored conversation session by default; rotate it
    // transparently on expiry/failure.
    conversationSessions: conversationSessionService,
    conversationMessages: conversationReplyRecorder,
    // Bot model override → app default model resolution (settings v14).
    settings: settingsService,
  });
  // Completes the reply loop: human messages in a bot conversation trigger a
  // run for a participant bot, resuming the stored session.
  const conversationCoordinator = new ConversationRunCoordinator({
    conversationService,
    runService,
    botRepo: repo,
  });
  const taskService = new TaskService({
    taskRepo,
    botRepo: repo,
    runService,
    clock: { now: () => Date.now() },
    ids: { generate: () => randomUUID() },
  });
  runService.setTaskResults(taskService);

  // Durable schedules (PLAN §9): the scheduler owns due-occurrence recording
  // and durable run enqueueing; runs carry trigger type "schedule" and are
  // attributed back to their occurrence via the run-result hook.
  const scheduleRepo = createSqliteScheduleRepository(db);
  const scheduleService = new ScheduleService({
    scheduleRepo,
    botRepo: repo,
    runService,
    // A scheduled run is a conversation between the bot and the user:
    // schedules without an explicit conversation get their own dedicated
    // thread with the human; the bot's result is posted there as a reply.
    threads: conversationService,
    activity: activityRepo,
    clock: { now: () => Date.now() },
    ids: { generate: () => randomUUID() },
    // Debug logging for schedule creation and scheduler runs (--show-scheduling-logs).
    showSchedulingLogs,
  });
  runService.setScheduleResults(scheduleService);

  // Remote MCP server (Approach B): in-process, exposed over HTTP at /mcp.
  const mcp = await createMcpServer({
    botRepo: repo,
    conversationCoordinator,
    runService,
    taskService,
    scheduleService,
  });
  mcpHandle = mcp;
  const activityService = new ActivityService({
    activityRepo,
    clock: { now: () => Date.now() },
    ids: { generate: () => randomUUID() },
  });

  // Helpers to register the remote MCP server in a bot's home directory and
  // inject a protocol block into its AGENTS.md.
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const protocolBlock = (botId: string, bots: { id: string; name: string; status: string }[]) => {
    const roster = bots
      .filter((b) => b.id !== botId && b.status === "active")
      .map((b) => `- ${b.id} (${b.name})`)
      .join("\n");
    return [
      "",
      "",
      "<!-- bebots-protocol -->",
      `You are bot ${botId}. You can communicate with other bots using the bebots MCP tools:`,
      "- list_bots: see all bots",
      "- send_message(target_bot_id, content): send a message to another bot; returns the bot's reply result. Messages you send to the same bot while working on your task are delivered to the bot's same thread and session, so you can have a multi-turn exchange; the linkage ends once you reply to the user",
      "- create_task(assignee, description): delegate work to another bot",
      "- schedule_run(prompt, every_minutes | at | cron, bot_id?, conversation_id?): schedule a bot run to fire later (while the app is running); the prompt is passed to a session at the trigger time. Each schedule gets its own thread with the user — when it fires, the run happens in that conversation and your result is posted there as your reply (the user can respond in the thread); pass conversation_id to post into an existing thread instead. Use list_schedules/cancel_schedule(schedule_id) to manage your schedules",
      "Other bots:",
      roster || "(none)",
      "You may also include @botId in a reply to route a message.",
      "<!-- /bebots-protocol -->",
    ].join("\n");
  };
  const writeBotMcpConfig = async (botId: string) => {
    if (!apiEndpoint) return;
    const home = workspace.homePath(asBotId(botId));
    fsMod.mkdirSync(home, { recursive: true });
    const cfg = {
      mcp: {
        servers: {
          bebots: {
            type: "remote",
            url: `${apiEndpoint.url}/mcp`,
            headers: {
              Authorization: `Bearer ${apiEndpoint.token}`,
              "X-Bebots-Bot-Id": botId,
            },
          },
        },
      },
    };
    fsMod.writeFileSync(pathMod.join(home, "opencode.json"), JSON.stringify(cfg, null, 2), "utf8");
  };
  const injectProtocol = async (botId: string) => {
    const home = workspace.homePath(asBotId(botId));
    const agentsPath = pathMod.join(home, "AGENTS.md");
    let persona = "";
    try {
      persona = fsMod.readFileSync(agentsPath, "utf8");
    } catch {
      persona = "";
    }
    // Strip any previous protocol block (including the corrupted variant
    // written by the pre-fix join("\\n"), which embedded literal "\n" text).
    persona = persona.replace(/\n\n<!-- bebots-protocol -->[\s\S]*?<!-- \/bebots-protocol -->/, "");
    persona = persona.replace(
      /\\n\\n<!-- bebots-protocol -->[\s\S]*?<!-- \/bebots-protocol -->/,
      "",
    );
    const bots = await Effect.runPromise(service.listBots(false));
    const block = protocolBlock(
      botId,
      bots.map((b) => ({ id: String(b.id), name: b.name, status: b.status })),
    );
    fsMod.writeFileSync(agentsPath, persona + block, "utf8");
  };
  const ensureBotSetup = async (botId: string) => {
    await writeBotMcpConfig(botId);
    await injectProtocol(botId);
  };

  closeDb = () => db.close();

  // PLAN §5: sessions expire after 30 days of inactivity — sweep at startup
  // and then hourly while the app runs.
  runLogged(conversationSessionService.expireStaleSessions());
  sessionSweepInterval = setInterval(
    () => {
      runLogged(conversationSessionService.expireStaleSessions());
    },
    60 * 60 * 1000,
  );

  // PLAN §9: durable scheduling — recover stale occurrences and fire due
  // schedules at startup, then tick every 30s while the app runs. Schedules
  // execute only while the application is running (MVP default).
  await Effect.runPromise(scheduleService.tick()).catch((error) =>
    console.error("Initial schedule tick failed", error instanceof Error ? error.message : error),
  );
  scheduleTickInterval = setInterval(() => {
    runLogged(scheduleService.tick());
  }, scheduleTickMs());

  // Token
  const tokenPath = join(userData, "api-token.txt");
  let token: string;
  const fs = await import("node:fs");
  if (fs.existsSync(tokenPath)) {
    token = fs.readFileSync(tokenPath, "utf8").trim();
  } else {
    token = randomUUID();
    fs.writeFileSync(tokenPath, token, "utf8");
  }

  // IPC handlers
  ipcMain.handle("bebots:bots:list", async (_event, includeArchived?: boolean) => {
    const bots = await Effect.runPromise(service.listBots(includeArchived ?? false));
    return bots.map((b) => ({ ...b, homePath: workspace.homePath(b.id) }));
  });
  ipcMain.handle("bebots:bots:get", async (_event, id: string) => {
    const bot = await Effect.runPromise(service.getBot(id as BotId));
    return bot ? { ...bot, homePath: workspace.homePath(bot.id) } : null;
  });
  ipcMain.handle("bebots:bots:create", async (_event, input) => {
    const bot = await Effect.runPromise(service.createBot(input));
    await ensureBotSetup(String(bot.id));
    return bot;
  });
  ipcMain.handle("bebots:bots:update", async (_event, id: string, input) => {
    const bot = await Effect.runPromise(service.updateBot(id as BotId, input));
    await ensureBotSetup(String(bot.id));
    return bot;
  });
  ipcMain.handle("bebots:bots:archive", async (_event, id: string) => {
    return Effect.runPromise(service.archiveBot(id as BotId));
  });
  ipcMain.handle("bebots:workspace:root", async () => {
    return workspace.root;
  });
  // Local HTTP API coordinates for the renderer (Electron-specific need;
  // renderer calls the same API as external clients, no IPC business path).
  ipcMain.handle("bebots:api:endpoint", () => apiEndpoint);

  // Tasks (IPC mirrors of the HTTP API; business logic stays in services).
  ipcMain.handle(
    "bebots:tasks:list",
    async (
      _event,
      options?: { requester?: string; assignee?: string; status?: TaskStatus; limit?: number },
    ) => {
      return Effect.runPromise(taskService.listTasks(options ?? {}));
    },
  );
  ipcMain.handle("bebots:tasks:get", async (_event, id: string) => {
    return Effect.runPromise(taskService.getTask(id));
  });
  ipcMain.handle("bebots:tasks:create", async (_event, input) => {
    return Effect.runPromise(taskService.createTask(input));
  });
  ipcMain.handle("bebots:tasks:assign", async (_event, id: string) => {
    return Effect.runPromise(taskService.assignTask(id));
  });
  ipcMain.handle("bebots:tasks:cancel", async (_event, id: string) => {
    return Effect.runPromise(taskService.cancelTask(id));
  });
  ipcMain.handle("bebots:tasks:delegate", async (_event, input) => {
    return Effect.runPromise(taskService.delegate(input));
  });

  // Schedules (IPC mirrors of the HTTP API; business logic stays in services).
  ipcMain.handle(
    "bebots:schedules:list",
    async (_event, options?: { botId?: string; createdBy?: string; limit?: number }) => {
      return Effect.runPromise(scheduleService.listSchedules(options));
    },
  );
  ipcMain.handle("bebots:schedules:get", async (_event, id: string) => {
    return Effect.runPromise(scheduleService.getSchedule(id as ScheduleId));
  });
  ipcMain.handle(
    "bebots:schedules:create",
    async (
      _event,
      input: {
        botId: string;
        prompt: string;
        trigger: unknown;
        enabled?: boolean;
        conversationId?: string | null;
        createdBy?: string | null;
      },
    ) => {
      return Effect.runPromise(
        scheduleService.createSchedule({
          botId: input.botId,
          prompt: input.prompt,
          trigger: input.trigger,
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.conversationId !== undefined && { conversationId: input.conversationId }),
          ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        }),
      );
    },
  );
  ipcMain.handle("bebots:schedules:update", async (_event, id: string, patch) => {
    return Effect.runPromise(scheduleService.updateSchedule(id, patch));
  });
  ipcMain.handle("bebots:schedules:delete", async (_event, id: string) => {
    return Effect.runPromise(scheduleService.deleteSchedule(id));
  });
  ipcMain.handle("bebots:schedules:history", async (_event, id: string, limit?: number) => {
    return Effect.runPromise(scheduleService.listHistory(id, limit));
  });

  ipcMain.handle(
    "bebots:runs:start",
    async (
      _event,
      input: { botId: string; prompt: string; timeoutMs?: number; sessionId?: string },
    ) => {
      const run = await Effect.runPromise(
        runService.startRun({
          botId: asBotId(input.botId),
          prompt: input.prompt,
          ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
          ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
          triggerType: "manual",
        }),
      );
      return run;
    },
  );
  ipcMain.handle("bebots:runs:get", async (_event, id: string) => {
    return Effect.runPromise(runService.getRun(asRunId(id)));
  });
  ipcMain.handle(
    "bebots:runs:list",
    async (_event, options?: { botId?: string; status?: RunStatus; limit?: number }) => {
      return Effect.runPromise(
        runService.listRuns({
          ...(options?.botId !== undefined && { botId: asBotId(options.botId) }),
          ...(options?.status !== undefined && { status: options.status }),
          ...(options?.limit !== undefined && { limit: options.limit }),
        }),
      );
    },
  );
  ipcMain.handle("bebots:runs:cancel", async (_event, id: string) => {
    return Effect.runPromise(runService.cancelRun(asRunId(id as string)));
  });
  ipcMain.handle("bebots:runs:events", async (_event, id: string) => {
    return Effect.runPromise(runService.getRunEvents(asRunId(id as string)));
  });
  ipcMain.handle("bebots:runs:await", async (_event, id: string, timeoutMs?: number) => {
    return Effect.runPromise(
      runService.awaitRun(asRunId(id as string), timeoutMs as number | undefined),
    );
  });

  // HTTP server
  const routes = makeRoutes({
    botService: service,
    runService,
    conversationService,
    conversationSessionService,
    conversationCoordinator,
    taskService,
    scheduleService,
    activityService,
    settingsService,
    token,
    runtime: runtimeInstance,
    indexer: indexerInstance,
    ensureBotSetup,
  });
  const webHandler = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = url.pathname;

      // CORS: frozen parity, except the allow-list now admits the tracing
      // headers Effect's HttpApiClient adds to every request (traceparent,
      // tracestate, b3) — without them the browser rejects the preflight of
      // every renderer-originated call (threads/models/settings never load).
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, traceparent, tracestate, b3",
      );
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Auth: frozen quirks.
      const auth = req.headers.authorization;
      if (auth && auth !== `Bearer ${token}` && auth !== token) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      // /mcp passthrough (out of scope).
      if (pathname === "/mcp") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        if (showMcpLogs) {
          const botId = req.headers["x-bebots-bot-id"];
          const headerBotId = Array.isArray(botId) ? botId[0] : botId;
          console.log(`[mcp] --> ${req.method} ${pathname} caller-bot=${headerBotId ?? "-"}`);
          console.log(`[mcp] request: ${formatMcpJson(buf.toString("utf8"))}`);
        }
        const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url}`, {
          method: req.method ?? "POST",
          headers: req.headers as Record<string, string>,
          ...(buf.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? { body: buf } : {}),
        });
        const response = await mcpHandle!.handleRequest(request);
        res.statusCode = response.status;
        response.headers.forEach((value: string, key: string) => res.setHeader(key, value));
        const ab = await response.arrayBuffer();
        if (showMcpLogs) {
          console.log(`[mcp] <-- ${response.status} ${pathname}`);
          console.log(`[mcp] response: ${formatMcpJson(Buffer.from(ab).toString("utf8"))}`);
        }
        res.end(Buffer.from(ab));
        return;
      }

      // Delegate everything else to the Effect web handler.
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const buf = Buffer.concat(chunks);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      let bodyBuf = buf;
      const reqHeaders = { ...(req.headers as Record<string, string>) };
      if (hasBody) {
        reqHeaders["content-type"] = "application/json";
        if (buf.length === 0) {
          bodyBuf = Buffer.from("{}", "utf8");
        }
      }
      const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url}`, {
        method: req.method ?? "GET",
        headers: reqHeaders,
        ...(hasBody ? { body: bodyBuf } : {}),
      });
      const response = await webHandler.handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value: string, key: string) => res.setHeader(key, value));
      const ab = await response.arrayBuffer();
      res.end(Buffer.from(ab));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  _httpServer = server;
  closeServer = () => server.close();
  apiPort = port;
  apiEndpoint = { url: `http://127.0.0.1:${port}`, token };
  fs.writeFileSync(join(userData, "api-port.txt"), String(port), "utf8");

  // Configure existing bots now that apiEndpoint is known.
  const existingBots = await Effect.runPromise(service.listBots(false));
  for (const b of existingBots) {
    await ensureBotSetup(String(b.id));
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // The renderer talks to the local HTTP API on this concrete origin
      // (narrowed from a blanket host allowance; see issue #13 for further
      // CSP tightening).
      const apiOrigin = apiPort !== null ? ` http://127.0.0.1:${apiPort}` : "";
      const csp = isDev
        ? `default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*${apiOrigin} ws://localhost:* data:; img-src 'self' data:; font-src 'self' data:`
        : `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'${apiOrigin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    });

    await setupBotService();

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((error) => {
    console.error("Failed to initialize app", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  closeServer?.();
  runtimeInstance?.close();
  indexerInstance?.close();
  if (sessionSweepInterval !== null) {
    clearInterval(sessionSweepInterval);
    sessionSweepInterval = null;
  }
  if (scheduleTickInterval !== null) {
    clearInterval(scheduleTickInterval);
    scheduleTickInterval = null;
  }
  closeDb?.();
});
