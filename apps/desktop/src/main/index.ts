import { app, BrowserWindow, ipcMain, session } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Effect } from "effect";
import { openDatabase, migrate, createSqliteBotRepository, createSqliteRunRepository } from "@bebots/persistence";
import { BotService, RunService } from "@bebots/application";
import type { BotId, RunStatus } from "@bebots/domain";
import { asBotId, asRunId } from "@bebots/domain";
import { OpenCodeRuntime } from "@bebots/runtime-opencode";
import { createNodeBotWorkspace } from "./workspace";

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
  const service = new BotService(
    repo,
    workspace,
    { now: () => Date.now() },
    {
      generate: () => randomUUID(),
    },
  );
  const runtime = new OpenCodeRuntime();
  runtimeInstance = runtime;
  const runService = new RunService(runRepo, repo, workspace, runtime, { now: () => Date.now() }, {
    generate: () => randomUUID(),
  });
  closeDb = () => db.close();

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
    return Effect.runPromise(service.createBot(input));
  });
  ipcMain.handle("bebots:bots:update", async (_event, id: string, input) => {
    return Effect.runPromise(service.updateBot(id as BotId, input));
  });
  ipcMain.handle("bebots:bots:archive", async (_event, id: string) => {
    return Effect.runPromise(service.archiveBot(id as BotId));
  });
  ipcMain.handle("bebots:workspace:root", async () => {
    return workspace.root;
  });

  ipcMain.handle("bebots:runs:start", async (_event, input: { botId: string; prompt: string; timeoutMs?: number; sessionId?: string }) => {
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
  });
  ipcMain.handle("bebots:runs:get", async (_event, id: string) => {
    return Effect.runPromise(runService.getRun(asRunId(id)));
  });
  ipcMain.handle("bebots:runs:list", async (_event, options?: { botId?: string; status?: RunStatus; limit?: number }) => {
    return Effect.runPromise(
      runService.listRuns({
        ...(options?.botId !== undefined && { botId: asBotId(options.botId) }),
        ...(options?.status !== undefined && { status: options.status }),
        ...(options?.limit !== undefined && { limit: options.limit }),
      }),
    );
  });
  ipcMain.handle("bebots:runs:cancel", async (_event, id: string) => {
    return Effect.runPromise(runService.cancelRun(asRunId(id as string)));
  });
  ipcMain.handle("bebots:runs:events", async (_event, id: string) => {
    return Effect.runPromise(runService.getRunEvents(asRunId(id as string)));
  });
  ipcMain.handle("bebots:runs:await", async (_event, id: string, timeoutMs?: number) => {
    return Effect.runPromise(runService.awaitRun(asRunId(id as string), timeoutMs as number | undefined));
  });

  // HTTP server
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = url.pathname;

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

      // Bots
      if (req.method === "GET" && pathname === "/api/v1/bots") {
        const list = await Effect.runPromise(service.listBots(url.searchParams.get("includeArchived") === "true"));
        sendJson(res, 200, list);
        return;
      }
      if (req.method === "POST" && pathname === "/api/v1/bots") {
        const body = (await readBody(req)) as { name?: string; description?: string; persona?: string };
        const bot = await Effect.runPromise(service.createBot({
          name: body.name ?? "New bot",
          ...(body.description !== undefined && { description: body.description }),
          ...(body.persona !== undefined && { persona: body.persona }),
        }));
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
          const body = (await readBody(req)) as { name?: string; description?: string; persona?: string; status?: "active" | "archived" };
          const bot = await Effect.runPromise(service.updateBot(id, body));
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
        const body = (await readBody(req)) as { prompt?: string; timeoutMs?: number; sessionId?: string };
        const run = await Effect.runPromise(
          runService.startRun({
            botId: id,
            prompt: body.prompt ?? "",
            timeoutMs: body.timeoutMs as number | undefined,
            sessionId: body.sessionId,
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
  fs.writeFileSync(join(userData, "api-port.txt"), String(port), "utf8");
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
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
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const csp = isDev
        ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:* data:; img-src 'self' data:; font-src 'self' data:"
        : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
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
  closeDb?.();
});
