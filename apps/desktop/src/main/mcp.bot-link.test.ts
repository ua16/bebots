import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type McpRpcBody = {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
  };
};

type SendMessageResult = {
  conversationId: string;
  messageId: string;
  runId: string | null;
  runs: { runId: string; status: string }[];
};

type RunDetail = { id: string; botId: string; sessionId?: string; status: string };

// The fake runtime starts a differently-named session when no sessionId was
// requested, and echoes the requested one when resuming — so asserting two
// runs share the same runtime session id proves resume actually happened.
vi.mock("@bebots/runtime-opencode", async () => {
  const { Effect, Stream } = await import("effect");
  let fresh = 0;
  let starts = 0;
  class FakeRuntime {
    readonly id = "fake";
    readonly capabilities = { streaming: true, resumableSessions: true, cancellation: true };
    startRun(request: { sessionId?: string }) {
      ++starts;
      return Effect.succeed({
        runId: `rt-${starts}`,
        sessionId: request.sessionId ?? `fresh-sess-${++fresh}`,
      });
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
  return { OpenCodeRuntime: FakeRuntime, createOpenCodeRuntime: () => new FakeRuntime(), OpenCodeAdapter: FakeRuntime };
});

async function pollUntil<T>(probe: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (ok(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("MCP bot-to-bot send_message session continuity (live app boot)", () => {
  let dir: string;
  let base: string;
  let token: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bebots-mcp-link-"));
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

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  }

  async function rpc(method: string, params: Record<string, unknown>, id: number, botId: string) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "X-Bebots-Bot-Id": botId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return (await res.json()) as McpRpcBody;
  }

  function toolPayload(response: McpRpcBody): SendMessageResult {
    const text = response.result?.content?.[0]?.text ?? "";
    return JSON.parse(text) as SendMessageResult;
  }

  async function createBot(name: string): Promise<{ id: string }> {
    const res = await api("POST", "/api/v1/bots", { name });
    return res.body as { id: string };
  }

  async function waitMessages(conversationId: string, min: number): Promise<unknown[]> {
    return pollUntil(async () => {
      const res = await api("GET", `/api/v1/conversations/${conversationId}/messages`);
      return (res.body as { messages?: unknown[] } | null)?.messages ?? (res.body as unknown[]);
    }, (messages) => (messages as unknown[]).length >= min);
  }

  it("routes a caller's follow-up sends into the same pinned conversation and the same session", async () => {
    const botA = await createBot("Caller");
    const botB = await createBot("Target");

    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }, 1, botA.id);

    const first = toolPayload(await rpc("tools/call", {
      name: "send_message",
      arguments: { target_bot_id: botB.id, content: "first message" },
    }, 2, botA.id));
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]?.status).toBe("succeeded");

    const second = toolPayload(await rpc("tools/call", {
      name: "send_message",
      arguments: { target_bot_id: botB.id, content: "follow-up message" },
    }, 3, botA.id));
    expect(second.runs).toHaveLength(1);
    expect(second.runs[0]?.status).toBe("succeeded");

    // Follow-up continues the original conversation, does not open a new one.
    expect(second.conversationId).toBe(first.conversationId);

    // Both recipient runs reused the same runtime session — the second run
    // resumed the session recorded by the first (fresh-sess-1), and did not
    // start fresh-sess-2.
    const run1 = (await api("GET", `/api/v1/runs/${first.runs[0]?.runId}`)).body as RunDetail;
    const run2 = (await api("GET", `/api/v1/runs/${second.runs[0]?.runId}`)).body as RunDetail;
    expect(run1.sessionId).toBe("fresh-sess-1");
    expect(run2.sessionId).toBe(run1.sessionId);

    // Persisted session bookkeeping: exactly one ConversationSession row for
    // the pinned conversation, owned by the target bot.
    await pollUntil(() => Promise.resolve(true), () => true);
    const db = new Database(join(dir, "app.sqlite"), { readonly: true });
    try {
      const convId = first.conversationId;
      const sessions = db
        .prepare("SELECT runtime_session_id, bot_id FROM conversation_sessions WHERE conversation_id = ? AND status = 'active'")
        .all(convId) as { runtime_session_id: string; bot_id: string | null }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.bot_id).toBe(botB.id);
      expect(sessions[0]?.runtime_session_id).toBe(run1.sessionId);

      // Only one direct conversation was ever created between the pair.
      const conversations = db
        .prepare("SELECT id, kind, participants FROM conversations WHERE kind = 'direct'")
        .all() as { id: string; participants: string }[];
      const betweenPair = conversations.filter((c) => {
        const participants: string[] = JSON.parse(c.participants);
        return participants.includes(botA.id) && participants.includes(botB.id);
      });
      expect(betweenPair).toHaveLength(1);

      // The whole exchange lives in that thread: caller's sends and the
      // target's replies.
      const messages = await waitMessages(convId, 4);
      expect(messages.every((m) => (m as { conversationId: string }).conversationId === convId)).toBe(true);
    } finally {
      db.close();
    }
  });
});
