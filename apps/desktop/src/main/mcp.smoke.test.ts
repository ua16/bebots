import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type McpRpcBody = {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
  };
};

vi.mock("@bebots/runtime-opencode", async () => {
  const { Effect, Stream } = await import("effect");
  class FakeRuntime {
    readonly id = "fake";
    readonly capabilities = { streaming: true, resumableSessions: true, cancellation: true };
    startRun(request: { sessionId?: string }) {
      return Effect.succeed({ runId: "rt-1", sessionId: request.sessionId ?? "sess-1" });
    }
    cancelRun() { return Effect.void; }
    streamEvents() { return Stream.empty; }
    getResult() { return Effect.succeed({ exitCode: 0, summary: "ok", sessionId: "sess-1" }); }
    close() {}
  }
  return { OpenCodeRuntime: FakeRuntime, createOpenCodeRuntime: () => new FakeRuntime(), OpenCodeAdapter: FakeRuntime };
});

describe("mcp HTTP endpoint", () => {
  let dir: string;
  let base: string;
  let token: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bebots-mcp-"));
    vi.resetModules();
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    const ipcMain = { handle: vi.fn() };
    const BrowserWindow = vi.fn().mockImplementation(() => ({ on: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn(), show: vi.fn() }));
    const winCtor = BrowserWindow as unknown as { getAllWindows?: () => unknown[] };
    winCtor.getAllWindows = vi.fn(() => []);
    vi.doMock("electron", () => ({
      app: { isPackaged: false, getPath: () => dir, whenReady: () => Promise.resolve(), on: vi.fn(), quit: vi.fn(), commandLine: { appendSwitch: vi.fn() } },
      BrowserWindow,
      ipcMain,
      session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    }));
    await import("./index.js");
    await new Promise((r) => setTimeout(r, 300));
    const fs = await import("node:fs");
    const port = fs.readFileSync(join(dir, "api-port.txt"), "utf8").trim();
    base = `http://127.0.0.1:${port}`;
    token = fs.readFileSync(join(dir, "api-token.txt"), "utf8").trim();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function rpc(method: string, params?: Record<string, unknown>, id: number = 1, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return { status: res.status, body: await res.json() };
  }

  it("initializes and lists tools", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);

    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const tools = await rpc("tools/list");
    expect(tools.status).toBe(200);
    const names = ((tools.body as McpRpcBody).result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("list_bots");
    expect(names).toContain("send_message");
    expect(names).toContain("create_task");
  });

  it("list_bots returns empty initially", async () => {
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const res = await rpc("tools/call", { name: "list_bots", arguments: {} }, 2, { "X-Bebots-Bot-Id": "bot-x" });
    expect(res.status).toBe(200);
    const text = ((res.body as McpRpcBody).result?.content?.[0]?.text) ?? "";
    expect(JSON.parse(text)).toEqual([]);
  });
});