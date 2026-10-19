import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Stream } from "effect";
import { asBotId } from "@bebots/domain";
import type { RunHandle, RuntimeEvent } from "@bebots/application";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { OpenCodeRuntime, createOpenCodeRuntime, OpenCodeAdapter } from "./index";

interface FakeProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function announceServer(proc: FakeProcess, url = "http://127.0.0.1:4321", password = "secret"): void {
  setTimeout(() => {
    proc.stdout.emit(
      "data",
      Buffer.from(`server listening on ${url}\nserver password ${password}\n`),
    );
  }, 0);
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function noContent(): Response {
  return {
    ok: true,
    status: 204,
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

interface FetchMock {
  readonly fn: ReturnType<typeof vi.fn>;
  readonly calls: Array<{ method: string; path: string; init?: RequestInit | undefined }>;
}

function makeFetch(
  handler: (method: string, path: string, init?: RequestInit) => Response,
): FetchMock {
  const calls: FetchMock["calls"] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search, init });
    return handler(method, url.pathname, init);
  });
  return { fn, calls };
}

/**
 * A handler that models a happy-path OpenCode server. `messages` is returned
 * for the session message poll; when it contains an `idle` entry the run
 * completes.
 */
function happyHandler(messages: unknown[]) {
  return (method: string, path: string): Response => {
    if (method === "GET" && path.endsWith("/message")) return jsonResponse(messages);
    if (method === "POST" && path === "/api/session") return jsonResponse({ id: "sess-1" });
    if (method === "POST" && path.endsWith("/prompt")) return noContent();
    if (method === "POST" && path.endsWith("/interrupt")) return noContent();
    if (method === "GET" && path.startsWith("/api/session/")) {
      return jsonResponse({ id: path.split("/").pop() });
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

async function collectEvents(
  stream: Stream.Stream<RuntimeEvent, unknown>,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of Stream.toAsyncIterable(stream) as AsyncIterable<RuntimeEvent>) {
    events.push(event);
  }
  return events;
}

async function drain(runtime: OpenCodeRuntime, handle: RunHandle): Promise<void> {
  try {
    await Effect.runPromise(runtime.getResult(handle));
  } catch {
    // terminal failure is irrelevant to cleanup
  }
}

function start(
  runtime: OpenCodeRuntime,
  overrides: Partial<Parameters<OpenCodeRuntime["startRun"]>[0]> = {},
) {
  return Effect.runPromise(
    runtime.startRun({
      botId: asBotId("bot-1"),
      workingDirectory: "/tmp/work",
      prompt: "hi",
      timeoutMs: 60_000,
      ...overrides,
    }),
  );
}

describe("OpenCodeRuntime", () => {
  let proc: FakeProcess;

  beforeEach(() => {
    proc = makeProcess();
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts a session, streams events, and returns the result", async () => {
    announceServer(proc);
    const { fn: fetchMock, calls } = makeFetch(
      happyHandler([
        { type: "idle", outcome: "succeeded" },
        { type: "assistant", content: [{ text: "hello world" }] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime({ baseDirectory: "/tmp/work" });
    const handle = await start(runtime, { prompt: "do the thing" });

    expect(handle.runId).toMatch(/^run_/);
    expect(handle.sessionId).toBe("sess-1");

    const promptCall = calls.find((c) => c.path.endsWith("/prompt"));
    expect(promptCall?.init?.body).toBe(JSON.stringify({ text: "do the thing" }));

    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("hello world");

    const events = await collectEvents(runtime.streamEvents(handle));
    expect(events.map((e) => e._tag)).toEqual(["started", "completed"]);
  });

  it("sends basic auth derived from the server password", async () => {
    announceServer(proc, "http://127.0.0.1:5555", "s3cret");
    const { fn: fetchMock, calls } = makeFetch(
      happyHandler([{ type: "idle", outcome: "succeeded" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    await drain(runtime, handle);

    const sessionCall = calls.find((c) => c.path === "/api/session");
    const headers = sessionCall?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`,
    );
  });

  it("resumes an existing session when the server knows it", async () => {
    announceServer(proc);
    const { fn: fetchMock, calls } = makeFetch((method, path) => {
      if (method === "GET" && path === "/api/session/existing") {
        return jsonResponse({ id: "existing" });
      }
      return happyHandler([{ type: "idle", outcome: "succeeded" }])(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { sessionId: "existing" });
    expect(handle.sessionId).toBe("existing");
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/session/existing")).toBe(true);
    await drain(runtime, handle);
  });

  it("creates the session with the requested id when it is missing", async () => {
    announceServer(proc);
    const { fn: fetchMock, calls } = makeFetch((method, path, init) => {
      if (method === "GET" && path === "/api/session/new-session") {
        return jsonResponse({ error: "missing" }, 404);
      }
      if (method === "POST" && path === "/api/session") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string };
        return jsonResponse({ id: body.id ?? "sess-1" });
      }
      return happyHandler([{ type: "idle", outcome: "succeeded" }])(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { sessionId: "new-session" });
    expect(handle.sessionId).toBe("new-session");
    const createCall = calls.find((c) => c.method === "POST" && c.path === "/api/session");
    expect(createCall?.init?.body).toContain("new-session");
    await drain(runtime, handle);
  });

  it("cancels a run and interrupts the session", async () => {
    announceServer(proc);
    const { fn: fetchMock, calls } = makeFetch(happyHandler([]));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);

    await Effect.runPromise(runtime.cancelRun(handle));
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(130);
    expect(result.summary).toBe("cancelled");
    expect(calls.some((c) => c.path.endsWith("/interrupt?resume=false"))).toBe(true);

    const events = await collectEvents(runtime.streamEvents(handle));
    expect(events.some((e) => e._tag === "failed")).toBe(true);
  });

  it("marks a run as timed out", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(happyHandler([]));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { timeoutMs: 5 });
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(124);
    expect(result.summary).toBe("timed out");
  });

  it("fails to start when the server API errors", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(() => jsonResponse({ error: "boom" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    await expect(start(runtime)).rejects.toMatchObject({ _tag: "RuntimeError" });
  });

  it("fails to start when the server exits early", async () => {
    setTimeout(() => proc.emit("exit", 1), 0);
    const runtime = new OpenCodeRuntime();
    await expect(start(runtime)).rejects.toMatchObject({ _tag: "RuntimeError" });
  });

  it("handles unknown runs", async () => {
    const runtime = new OpenCodeRuntime();
    await expect(
      Effect.runPromise(runtime.getResult({ runId: "missing" })),
    ).rejects.toBeDefined();
    await Effect.runPromise(runtime.cancelRun({ runId: "missing" }));
    expect(await collectEvents(runtime.streamEvents({ runId: "missing" }))).toEqual([]);
  });

  it("closes the server process", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(
      happyHandler([{ type: "idle", outcome: "succeeded" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    await drain(runtime, handle);

    runtime.close();
    expect(proc.kill).toHaveBeenCalled();
    // A second close is a no-op.
    runtime.close();
  });

  it("exposes the factory and compatibility alias", () => {
    expect(OpenCodeAdapter).toBe(OpenCodeRuntime);
    const runtime = createOpenCodeRuntime({ command: "echo", baseDirectory: "/x" });
    expect(runtime).toBeInstanceOf(OpenCodeRuntime);
    expect(runtime.id).toBe("opencode");
    expect(runtime.capabilities).toEqual({
      streaming: true,
      resumableSessions: true,
      cancellation: true,
    });
    runtime.close();
  });

  it("shares a single server across concurrent starts", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(happyHandler([{ type: "idle", outcome: "succeeded" }]));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const [first, second] = await Promise.all([start(runtime), start(runtime)]);
    expect(first.sessionId).toBe("sess-1");
    expect(second.sessionId).toBe("sess-1");
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    await drain(runtime, first);
    await drain(runtime, second);
  });

  it("does not throw when killing the server fails", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(happyHandler([{ type: "idle", outcome: "succeeded" }]));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    await drain(runtime, handle);

    proc.kill.mockImplementation(() => {
      throw new Error("kill failed");
    });
    expect(() => runtime.close()).not.toThrow();
  });

  it("fails to start when the server process errors", async () => {
    setTimeout(() => proc.emit("error", new Error("spawn boom")), 0);
    const runtime = new OpenCodeRuntime();
    await expect(start(runtime)).rejects.toMatchObject({ _tag: "RuntimeError" });
  });

  it("marks the run failed when polling throws", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "GET" && path.endsWith("/message")) throw new Error("poll boom");
      return happyHandler([])(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(1);

    const events = await collectEvents(runtime.streamEvents(handle));
    expect(events.some((e) => e._tag === "failed")).toBe(true);
  });

  it("unwraps wrapped { data } responses", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "POST" && path === "/api/session") {
        return jsonResponse({ data: { id: "wrapped" } });
      }
      if (method === "GET" && path.endsWith("/message")) {
        return jsonResponse({ data: [{ type: "idle", outcome: "succeeded" }] });
      }
      return happyHandler([])(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    expect(handle.sessionId).toBe("wrapped");
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(0);
  });

  it("streams events while a run is still in flight", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(
      happyHandler([{ type: "idle", outcome: "succeeded" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    const collected = collectEvents(runtime.streamEvents(handle));
    await Effect.runPromise(runtime.getResult(handle));
    const events = await collected;
    expect(events[0]?._tag).toBe("started");
  });

  it("tolerates interrupt failures when cancelling", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "POST" && path.includes("/interrupt")) throw new Error("interrupt boom");
      return happyHandler([])(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    await Effect.runPromise(runtime.cancelRun(handle));
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(130);
  });

  it("tolerates interrupt failures when timing out", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "POST" && path.includes("/interrupt")) throw new Error("interrupt boom");
      return happyHandler([])(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { timeoutMs: 5 });
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(124);
  });
});
