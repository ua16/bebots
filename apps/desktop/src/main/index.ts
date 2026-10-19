import { app, BrowserWindow, ipcMain, session } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { openDatabase, migrate, createSqliteBotRepository } from "@bebots/persistence";
import { BotService } from "@bebots/application";
import type { BotId } from "@bebots/domain";
import { createNodeBotWorkspace } from "./workspace";

const isDev = !app.isPackaged;

if (isDev) {
  app.commandLine?.appendSwitch("no-sandbox");
  app.commandLine?.appendSwitch("disable-gpu");
  app.commandLine?.appendSwitch("disable-software-rasterizer");
}

let closeDb: (() => void) | null = null;

async function setupBotService(): Promise<void> {
  if (typeof app.getPath !== "function") return;
  const userData = app.getPath("userData");
  const db = await openDatabase(join(userData, "app.sqlite"));
  migrate(db);
  const repo = createSqliteBotRepository(db);
  const workspace = createNodeBotWorkspace({ root: userData });
  const service = new BotService(
    repo,
    workspace,
    { now: () => Date.now() },
    {
      generate: () => randomUUID(),
    },
  );
  closeDb = () => db.close();

  ipcMain.handle("bebots:bots:list", async (_event, includeArchived?: boolean) => {
    return Effect.runPromise(service.listBots(includeArchived ?? false));
  });
  ipcMain.handle("bebots:bots:get", async (_event, id: string) => {
    return Effect.runPromise(service.getBot(id as BotId));
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
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
          ],
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
  closeDb?.();
});
