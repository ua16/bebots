import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { asBotId, asRunId } from "@bebots/domain";
import { createSqliteRunRepository, migrate, openDatabase } from "@bebots/persistence";
import { bootTestApp, type BootOptions, type BootedApp } from "./test-boot";
vi.mock("@bebots/runtime-opencode", () => import("./fake-runtime"));

describe("runs IPC and HTTP API", () => {
  let app: BootedApp;
  let base: string;
  let token: string;

  async function boot(options: BootOptions = {}): Promise<void> {
    app = await bootTestApp({
      tmpPrefix: "bebots-runs-",
      env: { ELECTRON_RENDERER_URL: "http://localhost:5173" },
      ...options,
    });
    base = app.base;
    token = app.token;
  }

  afterEach(() => {
    app?.appHandlers["before-quit"]?.();
    delete process.env.ELECTRON_RENDERER_URL;
    vi.restoreAllMocks();
    app?.dispose();
  });

  it("starts, lists, awaits, and cancels runs over IPC", async () => {
    await boot();
    const bot = (await app.handlers["bebots:bots:create"]!(null, { name: "Runner" })) as {
      id: string;
      name: string;
    };
    expect(bot.name).toBe("Runner");

    const listed = (await app.handlers["bebots:bots:list"]!(null, false)) as { homePath: string }[];
    expect(listed[0]?.homePath).toContain("bots");

    const run = (await app.handlers["bebots:runs:start"]!(null, {
      botId: bot.id,
      prompt: "go",
    })) as { id: string; status: string };
    expect(run.status).toBe("running");

    const fetched = (await app.handlers["bebots:runs:get"]!(null, run.id)) as { id: string };
    expect(fetched.id).toBe(run.id);

    const runs = (await app.handlers["bebots:runs:list"]!(null, { botId: bot.id })) as unknown[];
    expect(runs).toHaveLength(1);

    const events = await app.handlers["bebots:runs:events"]!(null, run.id);
    expect(Array.isArray(events)).toBe(true);

    const awaited = (await app.handlers["bebots:runs:await"]!(null, run.id, 2000)) as {
      status: string;
    };
    expect(awaited.status).toBe("succeeded");

    const cancelled = (await app.handlers["bebots:runs:cancel"]!(null, run.id)) as {
      status: string;
    };
    expect(cancelled.status).toBe("cancelled");

    const root = (await app.handlers["bebots:workspace:root"]!(null)) as string;
    expect(root).toContain("bots");

    const unknown = await app.handlers["bebots:bots:get"]!(null, "missing");
    expect(unknown).toBeNull();
  });

  it("serves the HTTP API", async () => {
    await boot();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const tokenRes = await fetch(`${base}/api/v1/token`);
    expect(((await tokenRes.json()) as { token: string }).token).toBe(token);

    const unauthorized = await fetch(`${base}/api/v1/bots`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(unauthorized.status).toBe(401);

    const created = await fetch(`${base}/api/v1/bots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Http Bot", persona: "p" }),
    });
    expect(created.status).toBe(201);
    const bot = (await created.json()) as { id: string; name: string };
    expect(bot.name).toBe("Http Bot");

    const listRes = await fetch(`${base}/api/v1/bots`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    expect((await listRes.json()) as unknown[]).toHaveLength(1);

    const gotRes = await fetch(`${base}/api/v1/bots/${bot.id}`);
    expect(gotRes.status).toBe(200);

    const missing = await fetch(`${base}/api/v1/bots/nope`);
    expect(missing.status).toBe(404);

    const patched = await fetch(`${base}/api/v1/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { name: string }).name).toBe("Renamed");

    const emptyBody = await fetch(`${base}/api/v1/bots`, { method: "POST" });
    expect(emptyBody.status).toBe(201);
    expect(((await emptyBody.json()) as { name: string }).name).toBe("New bot");

    const runRes = await fetch(`${base}/api/v1/bots/${bot.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ prompt: "run it" }),
    });
    expect(runRes.status).toBe(201);
    const run = (await runRes.json()) as { id: string; triggerType: string };
    expect(run.triggerType).toBe("api");

    const runsRes = await fetch(`${base}/api/v1/bots/${bot.id}/runs`);
    expect((await runsRes.json()) as unknown[]).toHaveLength(1);

    const getRunRes = await fetch(`${base}/api/v1/runs/${run.id}`);
    expect(getRunRes.status).toBe(200);

    const eventsRes = await fetch(`${base}/api/v1/runs/${run.id}/events`);
    expect(eventsRes.status).toBe(200);

    const cancelRes = await fetch(`${base}/api/v1/runs/${run.id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as { status: string }).status).toBe("cancelled");

    const notFound = await fetch(`${base}/api/v1/nope`);
    expect(notFound.status).toBe(404);

    const badBody = await fetch(`${base}/api/v1/bots`, { method: "POST", body: "{" });
    // Malformed JSON body now maps to 400 (named exception; see REFACTOR-PLAN.md contract gate).
    expect(badBody.status).toBe(400);
  });

  it("reuses an existing API token", async () => {
    await boot({
      beforeBoot(dir) {
        writeFileSync(join(dir, "api-token.txt"), "existing-token", "utf8");
      },
    });

    const res = await fetch(`${base}/api/v1/token`);
    expect(((await res.json()) as { token: string }).token).toBe("existing-token");
  });

  it("marks stale running runs as failed on startup", async () => {
    await boot({
      beforeBoot: async (bootDir) => {
        const db = await openDatabase(join(bootDir, "app.sqlite"));
        migrate(db);
        const repo = createSqliteRunRepository(db);
        await Effect.runPromise(
          repo.create({
            id: asRunId("stale"),
            botId: asBotId("bot-1"),
            triggerType: "manual",
            prompt: "p",
            status: "running",
            timeoutMs: 1,
            createdAt: 1,
            updatedAt: 1,
          }),
        );
        db.close();
      },
    });

    const res = await fetch(`${base}/api/v1/runs/stale`);
    const run = (await res.json()) as { status: string; error?: string };
    expect(run.status).toBe("failed");
    expect(run.error).toContain("restarted");
  });
});
