import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type BootedApp } from "./test-boot";

vi.mock("@bebots/runtime-opencode", () => import("./fake-runtime"));

describe("tasks HTTP API", () => {
  let app: BootedApp;
  let base: string;
  let token: string;

  beforeEach(async () => {
    app = await bootTestApp({
      tmpPrefix: "bebots-tasks-",
      env: { ELECTRON_RENDERER_URL: "http://localhost:5173" },
    });
    base = app.base;
    token = app.token;
  });

  afterEach(() => {
    app.dispose();
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
    const getRes = await fetch(`${base}/api/v1/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const updated = (await getRes.json()) as { status: string; resultSummary?: string };
    expect(updated.status).toBe("succeeded");
  });

  it("pauses and stops", async () => {
    const pauseRes = await fetch(`${base}/api/v1/control/pause`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pauseRes.status).toBe(200);
    const statusRes = await fetch(`${base}/api/v1/control/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const st = (await statusRes.json()) as { paused: boolean };
    expect(st.paused).toBe(true);
    // resume
    await fetch(`${base}/api/v1/control/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  });
});
