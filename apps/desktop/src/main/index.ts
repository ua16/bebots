import { app, BrowserWindow, ipcMain, session } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Effect } from "effect";
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
  ActivityService,
} from "@bebots/application";
import type { ConversationReplyRecorder } from "@bebots/application";
import type { BotId, ModelRef, RunStatus, TaskStatus } from "@bebots/domain";
import { asBotId, asRunId, asConversationId, asTaskId, validateModelRef } from "@bebots/domain";
import { OpenCodeRuntime } from "@bebots/runtime-opencode";
import { createNodeBotWorkspace, createWorkspaceIndexer } from "./workspace";
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
let runtimeInstance: { close(): void } | null = null;
let indexerInstance: { close(): void } | null = null;
let sessionSweepInterval: ReturnType<typeof setInterval> | null = null;
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

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Validate an HTTP-body model field (`{ providerID, id } | null`) against the
 * shared domain rules. `undefined` keeps the field untouched; `null` clears.
 */
function normalizeModelInput(value: unknown):
  | { readonly model?: ModelRef | null }
  | { readonly error: string } {
  const validated = validateModelRef(value);
  if (validated.valid) {
    // `value` is not undefined here, so the normalized value is a ref or null.
    return { model: validated.value ?? null };
  }
  return { error: `${validated.field}: ${validated.message}` };
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

  // Remote MCP server (Approach B): in-process, exposed over HTTP at /mcp.
  const mcp = await createMcpServer({
    botRepo: repo,
    conversationCoordinator,
    runService,
    taskService,
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
    persona = persona.replace(/\\n\\n<!-- bebots-protocol -->[\s\S]*?<!-- \/bebots-protocol -->/, "");
    const bots = await Effect.runPromise(service.listBots(false));
    const block = protocolBlock(botId, bots.map((b) => ({ id: String(b.id), name: b.name, status: b.status })));
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
  ipcMain.handle("bebots:tasks:list", async (_event, options?: { requester?: string; assignee?: string; status?: TaskStatus; limit?: number }) => {
    return Effect.runPromise(taskService.listTasks(options ?? {}));
  });
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
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = url.pathname;

      // CORS: the renderer runs on a different origin than this API (vite dev
      // server in dev, file:// in prod), so its fetches are cross-origin and
      // Chromium enforces CORS — without these headers every renderer request
      // is blocked before it reaches the routes. The API only listens on
      // 127.0.0.1 and is bearer-token authed with no ambient credentials, so
      // a wildcard origin is acceptable (issue #20).
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      );
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Auth: allow missing token for local dev/tests, validate if present.
      const auth = req.headers.authorization;
      if (auth && auth !== `Bearer ${token}` && auth !== token) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if (req.method === "GET" && pathname === "/api/v1/token") {
        sendJson(res, 200, { token });
        return;
      }

      // Models available to the runtime (picker data). The opencode server
      // may not be reachable yet — surface that as 503, not a 500.
      if (req.method === "GET" && pathname === "/api/v1/models") {
        const runtime = runtimeInstance as { listModels?(): unknown } | null;
        if (!runtime || typeof runtime.listModels !== "function") {
          sendJson(res, 501, { error: "Runtime does not support a model catalog" });
          return;
        }
        try {
          const models = await Effect.runPromise(
            (runtime.listModels as () => Effect.Effect<readonly unknown[], unknown>)(),
          );
          sendJson(res, 200, models);
        } catch (e) {
          sendJson(res, 503, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // App settings: only the default model for now.
      if (req.method === "GET" && pathname === "/api/v1/settings") {
        const defaultModel = await Effect.runPromise(settingsService.getDefaultModel());
        sendJson(res, 200, { defaultModel });
        return;
      }
      if (req.method === "PUT" && pathname === "/api/v1/settings") {
        const body = (await readBody(req)) as { defaultModel?: unknown };
        const normalized = normalizeModelInput(body.defaultModel);
        if ("error" in normalized) {
          sendJson(res, 400, { error: normalized.error });
          return;
        }
        // `undefined` is not valid for the default model itself — the field is
        // required in the body (use `null` to unset the override).
        if (!("model" in normalized)) {
          sendJson(res, 400, { error: "defaultModel must be an object or null" });
          return;
        }
        await Effect.runPromise(settingsService.setDefaultModel(normalized.model ?? null));
        const defaultModel = await Effect.runPromise(settingsService.getDefaultModel());
        sendJson(res, 200, { defaultModel });
        return;
      }

      // Bots
      if (req.method === "GET" && pathname === "/api/v1/bots") {
        const list = await Effect.runPromise(
          service.listBots(url.searchParams.get("includeArchived") === "true"),
        );
        sendJson(res, 200, list);
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/bots") {
        const body = (await readBody(req)) as {
          name?: string;
          description?: string;
          persona?: string;
          model?: unknown;
        };
        const model = normalizeModelInput(body.model);
        if ("error" in model) {
          sendJson(res, 400, { error: model.error });
          return;
        }
        const bot = await Effect.runPromise(
          service.createBot({
            name: body.name ?? "New bot",
            ...(body.description !== undefined && { description: body.description }),
            ...(body.persona !== undefined && { persona: body.persona }),
            ...("model" in model && { model: model.model }),
          }),
        );
        await ensureBotSetup(String(bot.id));
        sendJson(res, 201, bot);
        return;
      }
      const botMatch = pathname.match(/^\/api\/v1\/bots\/([^/]+)$/);
      if (botMatch) {
        const id = asBotId(decodeURIComponent(botMatch[1] as string));
        if (req.method === "GET") {
          const bot = await Effect.runPromise(service.getBot(id));
          sendJson(res, bot ? 200 : 404, bot);
          return;
        }
        if (req.method === "PATCH") {
          const body = (await readBody(req)) as {
            name?: string;
            description?: string;
            persona?: string;
            status?: "active" | "archived";
            model?: unknown;
          };
          const model = normalizeModelInput(body.model);
          if ("error" in model) {
            sendJson(res, 400, { error: model.error });
            return;
          }
          const bot = await Effect.runPromise(
            service.updateBot(id, {
              ...(body.name !== undefined && { name: body.name }),
              ...(body.description !== undefined && { description: body.description }),
              ...(body.persona !== undefined && { persona: body.persona }),
              ...(body.status !== undefined && { status: body.status }),
              ...("model" in model && { model: model.model }),
            }),
          );
          await ensureBotSetup(String(bot.id));
          sendJson(res, 200, bot);
          return;
        }
      }
      const botRunsMatch = pathname.match(/^\/api\/v1\/bots\/([^/]+)\/runs$/);
      if (botRunsMatch && req.method === "GET") {
        const id = asBotId(decodeURIComponent(botRunsMatch[1] as string));
        const runs = await Effect.runPromise(runService.listRuns({ botId: id }));
        sendJson(res, 200, runs);
        return;
      }
      const startRunMatch = pathname.match(/^\/api\/v1\/bots\/([^/]+)\/runs$/);
      if (startRunMatch && req.method === "POST") {
        const id = asBotId(decodeURIComponent(startRunMatch[1] as string));
        const body = (await readBody(req)) as {
          prompt?: string;
          timeoutMs?: number;
          sessionId?: string;
          conversationId?: string;
        };
        const run = await Effect.runPromise(
          runService.startRun({
            botId: id,
            prompt: body.prompt ?? "",
            ...(body.timeoutMs !== undefined && { timeoutMs: body.timeoutMs }),
            ...(body.sessionId !== undefined && { sessionId: body.sessionId }),
            ...(body.conversationId !== undefined && {
              conversationId: asConversationId(body.conversationId),
            }),
            triggerType: "api",
          } as never),
        );
        sendJson(res, 201, run);
        return;
      }

      const runMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (runMatch) {
        const id = asRunId(decodeURIComponent(runMatch[1] as string));
        if (req.method === "GET") {
          const run = await Effect.runPromise(runService.getRun(id));
          sendJson(res, run ? 200 : 404, run);
          return;
        }
      }
      const runEventsMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
      if (runEventsMatch && req.method === "GET") {
        const id = asRunId(decodeURIComponent(runEventsMatch[1] as string));
        const events = await Effect.runPromise(runService.getRunEvents(id));
        sendJson(res, 200, events);
        return;
      }
      const cancelMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const id = asRunId(decodeURIComponent(cancelMatch[1] as string));
        const run = await Effect.runPromise(runService.cancelRun(id));
        sendJson(res, run ? 200 : 404, run);
        return;
      }

      // Conversations
      if (req.method === "GET" && pathname === "/api/v1/conversations") {
        const list = await Effect.runPromise(conversationService.listConversations());
        sendJson(res, 200, list);
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/conversations") {
        const body = (await readBody(req)) as {
          kind?: "direct" | "team";
          title?: string;
          participants?: string[];
        };
        const conv = await Effect.runPromise(conversationService.createConversation(body ?? {}));
        sendJson(res, 201, conv);
        return;
      }
      const convMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)$/);
      if (convMatch) {
        const id = asConversationId(decodeURIComponent(convMatch[1] as string));
        if (req.method === "GET") {
          const conv = await Effect.runPromise(conversationService.getConversation(id));
          sendJson(res, conv ? 200 : 404, conv);
          return;
        }
        if (req.method === "PATCH") {
          const body = (await readBody(req)) as {
            kind?: "direct" | "team";
            title?: string;
            participants?: string[];
          };
          const conv = await Effect.runPromise(
            conversationService.updateConversation(id, body ?? {}),
          );
          sendJson(res, 200, conv);
          return;
        }
        if (req.method === "DELETE") {
          await Effect.runPromise(conversationService.deleteConversation(id));
          sendJson(res, 204, {});
          return;
        }
      }
      const convMsgsMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
      if (convMsgsMatch) {
        const id = asConversationId(decodeURIComponent(convMsgsMatch[1] as string));
        if (req.method === "GET") {
          const msgs = await Effect.runPromise(conversationService.listMessages(id));
          sendJson(res, 200, msgs);
          return;
        }
        if (req.method === "POST") {
          const body = (await readBody(req)) as {
            content?: string;
            senderType?: string;
          };
          // Full reply loop (PLAN §12 M3): a human message in a bot
          // conversation triggers a reply run; the summary lands back in the
          // thread when the run completes.
          const outcome = await Effect.runPromise(
            conversationCoordinator.sendMessage({
              conversationId: id,
              content: body.content ?? "",
              ...(body.senderType !== undefined && {
                senderType: body.senderType as "human" | "bot" | "system",
              }),
            }),
          );
          sendJson(res, 201, { message: outcome.message, runId: outcome.run?.id ?? null });
          return;
        }
      }
      const convSessionsMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/sessions$/);
      if (convSessionsMatch) {
        const id = asConversationId(decodeURIComponent(convSessionsMatch[1] as string));
        if (req.method === "GET") {
          const sessions = await Effect.runPromise(
            conversationSessionService.listSessions({ conversationId: id }),
          );
          sendJson(res, 200, sessions);
          return;
        }
        if (req.method === "POST") {
          const body = (await readBody(req)) as { runtimeSessionId?: string; botId?: string };
          const sess = await Effect.runPromise(
            conversationSessionService.createSession({
              conversationId: id,
              runtimeSessionId: body.runtimeSessionId ?? "",
              ...(body.botId !== undefined && { botId: body.botId }),
            }),
          );
          sendJson(res, 201, sess);
          return;
        }
      }

      // Tasks
      if (req.method === "GET" && pathname === "/api/v1/tasks") {
        const list = await Effect.runPromise(
          taskService.listTasks({
            ...(url.searchParams.get("requester") && { requester: url.searchParams.get("requester")! }),
            ...(url.searchParams.get("assignee") && { assignee: url.searchParams.get("assignee")! }),
            ...(url.searchParams.get("status") && {
              status: url.searchParams.get("status") as TaskStatus,
            }),
            ...(url.searchParams.get("limit") && {
              limit: Number(url.searchParams.get("limit")),
            }),
          }),
        );
        sendJson(res, 200, list);
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/tasks") {
        const body = (await readBody(req)) as {
          requester?: string | null;
          assignee?: string;
          description?: string;
          inputRefs?: string[];
          priority?: number;
          deadline?: number;
          depth?: number;
          idempotencyKey?: string;
          assign?: boolean;
        };
        const task = await Effect.runPromise(
          taskService.createTask({
            ...(body.requester !== undefined && { requester: body.requester }),
            assignee: body.assignee ?? "",
            description: body.description ?? "",
            ...(body.inputRefs !== undefined && { inputRefs: body.inputRefs }),
            ...(body.priority !== undefined && { priority: body.priority }),
            ...(body.deadline !== undefined && { deadline: body.deadline }),
            ...(body.depth !== undefined && { depth: body.depth }),
            ...(body.idempotencyKey !== undefined && { idempotencyKey: body.idempotencyKey }),
          }),
        );
        if (body.assign) {
          const started = await Effect.runPromise(taskService.assignTask(String(task.id)));
          sendJson(res, 201, started);
          return;
        }
        sendJson(res, 201, task);
        return;
      }
      const taskMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const id = asTaskId(decodeURIComponent(taskMatch[1] as string));
        if (req.method === "GET") {
          const task = await Effect.runPromise(taskService.getTask(String(id)));
          sendJson(res, task ? 200 : 404, task);
          return;
        }
      }
      const taskAssignMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/assign$/);
      if (taskAssignMatch && req.method === "POST") {
        const id = asTaskId(decodeURIComponent(taskAssignMatch[1] as string));
        const task = await Effect.runPromise(taskService.assignTask(String(id)));
        sendJson(res, 200, task);
        return;
      }
      const taskCancelMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/cancel$/);
      if (taskCancelMatch && req.method === "POST") {
        const id = asTaskId(decodeURIComponent(taskCancelMatch[1] as string));
        const task = await Effect.runPromise(taskService.cancelTask(String(id)));
        sendJson(res, 200, task);
        return;
      }
      // Delegate (create+assign+run) convenience
      if (req.method === "POST" && pathname === "/api/v1/tasks/delegate") {
        const body = (await readBody(req)) as {
          requester?: string | null;
          assignee?: string;
          description?: string;
          assignees?: string[];
          parallel?: boolean;
        };
        if (body.parallel && body.assignees) {
          const tasks = await Effect.runPromise(
            taskService.delegateParallel(
              body.assignees.map((a) => ({
                requester: body.requester ?? null,
                assignee: a,
                description: body.description ?? "",
              })),
            ),
          );
          sendJson(res, 201, tasks);
          return;
        }
        const task = await Effect.runPromise(
          taskService.delegate({
            requester: body.requester ?? null,
            assignee: body.assignee ?? "",
            description: body.description ?? "",
          }),
        );
        sendJson(res, 201, task);
        return;
      }

      // Activity feed
      if (req.method === "GET" && pathname === "/api/v1/activity") {
        const list = await Effect.runPromise(
          activityService.list({
            ...(url.searchParams.get("type") && { type: url.searchParams.get("type")! }),
            ...(url.searchParams.get("entityType") && {
              entityType: url.searchParams.get("entityType")!,
            }),
            ...(url.searchParams.get("entityId") && {
              entityId: url.searchParams.get("entityId")!,
            }),
            ...(url.searchParams.get("limit") && {
              limit: Number(url.searchParams.get("limit")),
            }),
          }),
        );
        sendJson(res, 200, list);
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/activity") {
        const body = (await readBody(req)) as {
          type?: string;
          entityType?: string;
          entityId?: string;
          actorId?: string | null;
          payload?: unknown;
        };
        const ev = await Effect.runPromise(
          activityService.record({
            type: body.type ?? "event",
            entityType: body.entityType ?? "unknown",
            entityId: body.entityId ?? "",
            ...(body.actorId !== undefined && { actorId: body.actorId }),
            payload: body.payload,
          }),
        );
        sendJson(res, 201, ev);
        return;
      }

      // Remote MCP endpoint (Approach B): Streamable HTTP, JSON responses.
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
        response.headers.forEach((value, key) => res.setHeader(key, value));
        const ab = await response.arrayBuffer();
        if (showMcpLogs) {
          console.log(`[mcp] <-- ${response.status} ${pathname}`);
          console.log(`[mcp] response: ${formatMcpJson(Buffer.from(ab).toString("utf8"))}`);
        }
        res.end(Buffer.from(ab));
        return;
      }

      // Global pause/stop
      if (req.method === "GET" && pathname === "/api/v1/control/status") {
        sendJson(res, 200, { paused: runService.isPaused() });
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/control/pause") {
        runService.pause();
        sendJson(res, 200, { paused: true });
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/control/resume") {
        runService.resume();
        sendJson(res, 200, { paused: false });
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/control/stop") {
        await Effect.runPromise(runService.cancelAllRuns());
        runService.pause();
        sendJson(res, 200, { paused: true });
        return;
      }

      // Workspace search over indexed notes/memory/logs (PLAN §7).
      if (req.method === "GET" && pathname === "/api/v1/notes/search") {
        const query = url.searchParams.get("q") ?? "";
        if (query.trim().length === 0) {
          sendJson(res, 400, { error: "Query parameter q is required" });
          return;
        }
        const botParam = url.searchParams.get("botId");
        const hits = await Effect.runPromise(
          indexer.search(query, botParam ? asBotId(botParam) : undefined),
        );
        sendJson(res, 200, hits);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
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
  closeDb?.();
});
