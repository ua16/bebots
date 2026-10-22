import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("tasks HTTP API", () => {
  let dir: string;
  let base: string;
  let token: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bebots-tasks-"));
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
    await new Promise((r) => setTimeout(r, 200));
    const fs = await import("node:fs");
    const port = fs.readFileSync(join(dir, "api-port.txt"), "utf8").trim();
    base = `http://127.0.0.1:${port}`;
    token = fs.readFileSync(join(dir, "api-token.txt"), "utf8").trim();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("delegates task and completes", async () => {
    const botRes = await fetch(`${base}/api/v1/bots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bot A" }),
    });
    const bot = (await botRes.json()) as { id: string };
    const taskRes = await fetch(`${base}/api/v1/tasks/delegate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ assignee: bot.id, description: "do work" }),
    });
    expect(taskRes.status).toBe(201);
    const task = (await taskRes.json()) as { id: string; status: string };
    // wait for finalization
    await new Promise((r) => setTimeout(r, 100));
    const getRes = await fetch(`${base}/api/v1/tasks/${task.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const updated = (await getRes.json()) as { status: string; resultSummary?: string };
    expect(updated.status).toBe("succeeded");
  });

  it("pauses and stops", async () => {
    const pauseRes = await fetch(`${base}/api/v1/control/pause`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(pauseRes.status).toBe(200);
    const statusRes = await fetch(`${base}/api/v1/control/status`, { headers: { Authorization: `Bearer ${token}` } });
    const st = (await statusRes.json()) as { paused: boolean };
    expect(st.paused).toBe(true);
    // resume
    await fetch(`${base}/api/v1/control/resume`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  });
});
