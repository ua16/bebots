// Shared live-app boot fixture for the main-process HTTP/MCP suites (PR 5 of
// the API layer foundation refactor; see REFACTOR-PLAN.md).
//
// Each suite used to hand-copy the same ~50-line block: temp user-data dir,
// `electron` module mock (with a `BrowserWindow as unknown as …` cast), a
// `./index` import, a fixed sleep, and reading `api-port.txt`/`api-token.txt`.
// `bootTestApp()` owns all of it; suite assertions are unchanged, only the
// scaffolding moved here.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export type McpRpcBody = {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { message: string };
};

export type IpcHandler = (...args: unknown[]) => unknown;

export type BootedApp = {
  /** Fake user-data dir handed to the app via `app.getPath`. */
  dir: string;
  /** `http://127.0.0.1:<port>`, read from `api-port.txt` once the server is up. */
  base: string;
  /** Bearer token from `api-token.txt`. */
  token: string;
  /** Channel → listener, captured from the mocked `ipcMain.handle`. */
  handlers: Record<string, IpcHandler>;
  /** App-level event listeners captured from the mocked `app.on`. */
  appHandlers: Record<string, IpcHandler>;
  /** The mocked `ipcMain`, exposed so suites can assert handle calls. */
  ipcMain: { handle: ReturnType<typeof vi.fn> };
  /** Remove the fake user-data dir. */
  dispose: () => void;
};

export type BootOptions = {
  /** Temp-dir prefix for the fake user-data dir. */
  tmpPrefix?: string;
  /**
   * Boot into this directory instead of a fresh temp dir (reboot scenario).
   */
  existingDir?: string;
  /** Env keys to set (string value) or clear (`undefined`) before the import. */
  env?: Record<string, string | undefined>;
  /**
   * Run after the temp dir exists and env is set, but before `./index` is
   * imported — for writing fixture files (e.g. an existing `api-token.txt`)
   * or installing spies the app must see during boot.
   */
  beforeBoot?: (dir: string) => void | Promise<void>;
};

export async function bootTestApp(options: BootOptions = {}): Promise<BootedApp> {
  const dir =
    options.existingDir ?? mkdtempSync(join(tmpdir(), options.tmpPrefix ?? "bebots-test-"));
  vi.resetModules();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await options.beforeBoot?.(dir);

  // The previous boot's port file would confuse the readiness poll below
  // with a stale port — drop it before re-import.
  if (options.existingDir) {
    rmSync(join(dir, "api-port.txt"), { force: true });
  }

  const handlers: Record<string, IpcHandler> = {};
  const appHandlers: Record<string, IpcHandler> = {};
  const ipcMain = {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers[channel] = listener;
    }),
  };
  // `Object.assign` keeps this cast-free: attaching the static `getAllWindows`
  // to a `BrowserWindow`-typed mock is exactly the `as unknown as` the suites
  // used to repeat inline.
  const BrowserWindow = vi.fn(() => ({
    on: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    show: vi.fn(),
  }));
  Object.assign(BrowserWindow, { getAllWindows: vi.fn(() => [] as unknown[]) });

  vi.doMock("electron", () => ({
    app: {
      isPackaged: false,
      getPath: () => dir,
      whenReady: () => Promise.resolve(),
      on: (event: string, cb: IpcHandler) => {
        appHandlers[event] = cb;
      },
      quit: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    },
    BrowserWindow,
    ipcMain,
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  }));

  await import("./index.js");
  await waitForBoot(dir);

  const base = `http://127.0.0.1:${readFileSync(join(dir, "api-port.txt"), "utf8").trim()}`;
  const token = readFileSync(join(dir, "api-token.txt"), "utf8").trim();

  return {
    dir,
    base,
    token,
    handlers,
    appHandlers,
    ipcMain,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Restart the app on the same user-data dir (persistence round-trip): closes
 * server, runtime, indexer and DB through the captured `before-quit`
 * handler, re-boots `./index` on `app.dir`, and returns a NEW `BootedApp`
 * with the fresh port (the token is reused) re-read from the handshake
 * files. Env keys from the original boot stay set on `process.env`.
 */
export async function reboot(app: BootedApp): Promise<BootedApp> {
  app.appHandlers["before-quit"]?.();
  return bootTestApp({ existingDir: app.dir });
}

/**
 * `api-port.txt` is written after `server.listen` resolves, so its existence
 * proves the server is up — poll for it instead of sleeping a fixed
 * 50–300ms per suite.
 */
async function waitForBoot(dir: string): Promise<void> {
  const portPath = join(dir, "api-port.txt");
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (existsSync(portPath)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("bebots test boot: api-port.txt never appeared within 5s");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Authorized JSON request against the booted app; body parsed as unknown. */
export async function api(
  app: BootedApp,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${app.base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${app.token}`,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as unknown) };
}

/** JSON-RPC POST against `/mcp`, with the shared Accept/auth headers. */
export async function mcpRpc(
  app: BootedApp,
  method: string,
  params?: Record<string, unknown>,
  id: number = 1,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: McpRpcBody }> {
  const res = await fetch(`${app.base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${app.token}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: (await res.json()) as McpRpcBody };
}

/** Unwrap an MCP tool-call response: parse its first text content. */
export function toolPayload<T>(response: McpRpcBody): T {
  const text = response.result?.content?.[0]?.text ?? "";
  return JSON.parse(text) as T;
}

/** Create a bot through the HTTP API. */
export async function createBot(app: BootedApp, name: string): Promise<{ id: string }> {
  const res = await api(app, "POST", "/api/v1/bots", { name });
  return res.body as { id: string };
}
