import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, api, createBot, type BootedApp } from "./test-boot";

vi.mock("@bebots/runtime-opencode", () => import("./fake-runtime"));

type SseMessage = {
  readonly event?: string;
  readonly data?: string;
  readonly id?: string;
};

function parseSseChunk(text: string): SseMessage[] {
  const messages: SseMessage[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const msg: { event?: string; data?: string; id?: string } = {};
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) msg.event = line.slice(6).trim();
      else if (line.startsWith("id:")) msg.id = line.slice(3).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) msg.data = dataLines.join("\n");
    messages.push(msg);
  }
  return messages;
}

async function readSseUntil(
  res: Response,
  predicate: (events: unknown[]) => boolean,
  timeoutMs = 8000,
): Promise<unknown[]> {
  if (!res.body) throw new Error("missing SSE body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const read = reader.read();
      const timed = await Promise.race([
        read.then((r) => ({ tag: "read" as const, r })),
        new Promise<{ tag: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ tag: "timeout" }), Math.max(1, remaining)),
        ),
      ]);
      if (timed.tag === "timeout") break;
      const { done, value } = timed.r;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const msg of parseSseChunk(`${part}\n\n`)) {
          if (!msg.data) continue;
          events.push(JSON.parse(msg.data) as unknown);
        }
      }
      if (predicate(events)) return events;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error(`SSE timed out; got ${events.length} event(s)`);
}

describe("SSE live events API", () => {
  let app: BootedApp;

  afterEach(() => {
    app?.appHandlers["before-quit"]?.();
    delete process.env.ELECTRON_RENDERER_URL;
    vi.restoreAllMocks();
    app?.dispose();
  });

  it("streams activity events to subscribers", async () => {
    app = await bootTestApp({
      tmpPrefix: "bebots-sse-",
      env: { ELECTRON_RENDERER_URL: "http://localhost:5173" },
    });

    const streamRes = await fetch(`${app.base}/api/v1/events`, {
      headers: { Authorization: `Bearer ${app.token}`, Accept: "text/event-stream" },
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type") ?? "").toContain("text/event-stream");

    const waiting = readSseUntil(
      streamRes,
      (events) => events.some((e) => (e as { kind?: string }).kind === "activity"),
    );
    // Let the bridge subscribe to the bus before publishing.
    await new Promise((r) => setTimeout(r, 50));

    const posted = await api(app, "POST", "/api/v1/activity", {
      type: "test.ping",
      entityType: "bot",
      entityId: "b-sse",
      payload: { ok: true },
    });
    expect(posted.status).toBe(201);

    const events = await waiting;
    const activity = events.find((e) => (e as { kind?: string }).kind === "activity") as {
      v: number;
      kind: string;
      activity: { type: string; entityId: string };
    };
    expect(activity.v).toBe(1);
    expect(activity.activity.type).toBe("test.ping");
    expect(activity.activity.entityId).toBe("b-sse");
  });

  it("streams run progress and keeps JSON history endpoint", async () => {
    app = await bootTestApp({
      tmpPrefix: "bebots-sse-run-",
      env: { ELECTRON_RENDERER_URL: "http://localhost:5173" },
    });
    const bot = await createBot(app, "SSE Runner");

    const streamRes = await fetch(`${app.base}/api/v1/events`, {
      headers: { Authorization: `Bearer ${app.token}`, Accept: "text/event-stream" },
    });
    expect(streamRes.status).toBe(200);

    const waiting = readSseUntil(
      streamRes,
      (events) =>
        events.some((e) => (e as { kind?: string }).kind === "run.event") &&
        events.some((e) => (e as { kind?: string }).kind === "run.updated"),
    );
    await new Promise((r) => setTimeout(r, 50));

    const runRes = await api(app, "POST", `/api/v1/bots/${bot.id}/runs`, { prompt: "stream me" });
    expect(runRes.status).toBe(201);
    const run = runRes.body as { id: string };

    const events = await waiting;
    expect(events.some((e) => (e as { kind?: string }).kind === "run.updated")).toBe(true);
    expect(
      events.some(
        (e) =>
          (e as { kind?: string; runId?: string }).kind === "run.event" &&
          (e as { runId?: string }).runId === run.id,
      ),
    ).toBe(true);

    const history = await api(app, "GET", `/api/v1/runs/${run.id}/events`);
    expect(history.status).toBe(200);
    expect(Array.isArray(history.body)).toBe(true);
  });

  it("filters by runId and cleans up on disconnect", async () => {
    app = await bootTestApp({
      tmpPrefix: "bebots-sse-filter-",
      env: { ELECTRON_RENDERER_URL: "http://localhost:5173" },
    });
    const bot = await createBot(app, "Filter Bot");

    const runA = (
      await api(app, "POST", `/api/v1/bots/${bot.id}/runs`, { prompt: "a" })
    ).body as { id: string };
    const runB = (
      await api(app, "POST", `/api/v1/bots/${bot.id}/runs`, { prompt: "b" })
    ).body as { id: string };

    const controller = new AbortController();
    const streamRes = await fetch(`${app.base}/api/v1/events?runId=${encodeURIComponent(runA.id)}`, {
      headers: { Authorization: `Bearer ${app.token}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(streamRes.status).toBe(200);

    const waiting = readSseUntil(streamRes, (events) =>
      events.some(
        (e) =>
          (e as { kind?: string; run?: { id?: string } }).kind === "run.updated" &&
          (e as { run?: { id?: string } }).run?.id === runA.id,
      ),
    );
    await new Promise((r) => setTimeout(r, 50));

    // Cancel publishes run.updated for both; the filtered stream should only
    // surface runA.
    await api(app, "POST", `/api/v1/runs/${runA.id}/cancel`);
    await api(app, "POST", `/api/v1/runs/${runB.id}/cancel`);

    const events = await waiting;
    expect(
      events.every((e) => {
        const ev = e as {
          kind?: string;
          runId?: string;
          run?: { id?: string };
          activity?: { entityId?: string };
        };
        if (ev.kind === "run.event") return ev.runId === runA.id;
        if (ev.kind === "run.updated") return ev.run?.id === runA.id;
        if (ev.kind === "activity") return ev.activity?.entityId === runA.id;
        return false;
      }),
    ).toBe(true);

    controller.abort();
    // Give the bridge a tick to tear down the subscriber; a second activity
    // publish after abort must not hang the process (cleanup smoke).
    await api(app, "POST", "/api/v1/activity", {
      type: "after.disconnect",
      entityType: "bot",
      entityId: bot.id,
    });
  });
});
