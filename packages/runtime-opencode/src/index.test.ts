import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Stream } from "effect";
import { asBotId, asFormId } from "@bebots/domain";
import type { RunHandle, RuntimeEvent } from "@bebots/application";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { OpenCodeRuntime, createOpenCodeRuntime } from "./index";

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

function announceServer(
  proc: FakeProcess,
  url = "http://127.0.0.1:4321",
  password = "secret",
): void {
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
 * Happy-path OpenCode server: completion comes from `session.execution.*`
 * on the event stream after each prompt; messages are fetched once for the summary.
 */
function happyHandler(messages: unknown[], sessionId = "sess-1") {
  let messageCalls = 0;
  let sessionSeq = 0;
  const enc = new TextEncoder();
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];

  const emitExec = (id: string) => {
    const frame = enc.encode(
      `data: ${JSON.stringify({
        type: "session.execution.succeeded",
        data: { sessionID: id },
      })}\n\n`,
    );
    for (const controller of controllers) {
      try {
        controller.enqueue(frame);
      } catch {
        /* closed */
      }
    }
  };

  return (method: string, path: string): Response => {
    if (method === "GET" && path === "/api/event") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`),
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (method === "GET" && path.endsWith("/message")) {
      messageCalls += 1;
      return jsonResponse(messageCalls === 1 ? [] : messages);
    }
    if (method === "POST" && path === "/api/session") {
      sessionSeq += 1;
      const id = sessionSeq === 1 ? sessionId : `${sessionId}-${sessionSeq}`;
      return jsonResponse({ id });
    }
    if (method === "POST" && path.endsWith("/prompt")) {
      const parts = path.split("/");
      const id = parts[parts.indexOf("session") + 1] ?? sessionId;
      queueMicrotask(() => emitExec(id));
      return noContent();
    }
    if (method === "POST" && path.endsWith("/interrupt")) return noContent();
    if (method === "DELETE" && path.includes("/form/")) return noContent();
    if (method === "POST" && path.includes("/form/") && path.endsWith("/reply")) return noContent();
    if (method === "GET" && path.includes("/form/")) {
      return jsonResponse({
        id: "frm_1",
        sessionID: sessionId,
        title: "Pick one",
        fields: [
          {
            type: "string",
            key: "q0",
            title: "Choice",
            options: [{ value: "a", label: "A" }],
            custom: true,
          },
        ],
      });
    }
    if (method === "GET" && path.startsWith("/api/session/")) {
      return jsonResponse({ id: path.split("/").pop() });
    }
    if (method === "GET" && path === "/api/model") return jsonResponse({ data: [] });
    return jsonResponse({ error: "not found" }, 404);
  };
}

/** Never completes via events — used for cancel/timeout tests. */
function hangingHandler(sessionId = "sess-1") {
  const enc = new TextEncoder();
  return (method: string, path: string): Response => {
    if (method === "GET" && path === "/api/event") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`),
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (method === "GET" && path.endsWith("/message")) return jsonResponse([]);
    if (method === "POST" && path === "/api/session") return jsonResponse({ id: sessionId });
    if (method === "POST" && path.endsWith("/prompt")) return noContent();
    if (method === "POST" && path.endsWith("/interrupt")) return noContent();
    if (method === "DELETE" && path.includes("/form/")) return noContent();
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
    const handler = happyHandler([{ type: "idle", outcome: "succeeded" }]);
    const { fn: fetchMock, calls } = makeFetch((method, path) => {
      if (method === "GET" && path === "/api/session/existing") {
        return jsonResponse({ id: "existing" });
      }
      return handler(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { sessionId: "existing" });
    expect(handle.sessionId).toBe("existing");
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/session/existing")).toBe(true);
    await drain(runtime, handle);
  });

  it("reports only this run's messages on a resumed session (issue #21)", async () => {
    announceServer(proc);
    // The session already holds earlier runs' messages — historically the
    // poll found the FIRST idle/assistant pair in the whole session, so every
    // resumed run completed instantly with the original run's stale reply.
    const historical = [
      { id: "m-hist-idle", type: "idle", outcome: "succeeded" },
      { id: "m-hist-assistant", type: "assistant", content: [{ text: "stale first reply" }] },
    ];
    const fresh = [
      ...historical,
      { id: "m-new-idle", type: "idle", outcome: "succeeded" },
      {
        id: "m-new-assistant",
        type: "assistant",
        content: [{ text: "the real answer" }],
      },
    ];
    let prompted = false;
    const base = happyHandler(fresh, "existing");
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "GET" && path === "/api/session/existing") {
        return jsonResponse({ id: "existing" });
      }
      if (method === "GET" && path.endsWith("/message")) {
        return jsonResponse(prompted ? fresh : historical);
      }
      if (method === "POST" && path.endsWith("/prompt")) {
        prompted = true;
        return base(method, path);
      }
      return base(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { sessionId: "existing" });
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.summary).toBe("the real answer");
  });

  it("posts only text parts as the summary, not reasoning parts", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(
      happyHandler([
        {
          id: "m-assistant",
          type: "assistant",
          content: [
            { type: "reasoning", text: "internal model thoughts" },
            { type: "text", text: "the visible answer" },
          ],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.summary).toBe("the visible answer");
  });

  it("starts a genuinely new session when the stored session is missing", async () => {
    announceServer(proc);
    const handler = happyHandler([{ type: "idle", outcome: "succeeded" }]);
    const { fn: fetchMock, calls } = makeFetch((method, path, init) => {
      if (method === "GET" && path === "/api/session/new-session") {
        return jsonResponse({ error: "missing" }, 404);
      }
      if (method === "POST" && path === "/api/session") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string };
        return jsonResponse({ id: body.id ?? "sess-1" });
      }
      return handler(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { sessionId: "new-session" });
    // Transparent recovery: the stale id is not retried or re-created — the
    // runtime hands back the id of the fresh session it created.
    expect(handle.sessionId).toBe("sess-1");
    const createCall = calls.find((c) => c.method === "POST" && c.path === "/api/session");
    expect(JSON.parse(String(createCall?.init?.body ?? "{}")).id).toBeUndefined();
    await drain(runtime, handle);
  });

  it("cancels a run and interrupts the session", async () => {
    announceServer(proc);
    const { fn: fetchMock, calls } = makeFetch(hangingHandler());
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

  it("dismisses a form and interrupts the session", async () => {
    announceServer(proc);
    const { fn: fetchMock, calls } = makeFetch(hangingHandler());
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);

    await Effect.runPromise(runtime.dismissForm(handle, asFormId("frm_1")));
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(130);
    expect(result.summary).toBe("cancelled");
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.path === "/api/session/sess-1/form/frm_1",
      ),
    ).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/interrupt?resume=false"))).toBe(true);
  });

  it("marks a run as timed out", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(hangingHandler());
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
    await expect(Effect.runPromise(runtime.getResult({ runId: "missing" }))).rejects.toBeDefined();
    await Effect.runPromise(runtime.cancelRun({ runId: "missing" }));
    expect(await collectEvents(runtime.streamEvents({ runId: "missing" }))).toEqual([]);
  });

  it("closes the server process", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(happyHandler([{ type: "idle", outcome: "succeeded" }]));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    await drain(runtime, handle);

    runtime.close();
    expect(proc.kill).toHaveBeenCalled();
    // A second close is a no-op.
    runtime.close();
  });

  it("exposes the factory", () => {
    const runtime = createOpenCodeRuntime({ command: "echo", baseDirectory: "/x" });
    expect(runtime).toBeInstanceOf(OpenCodeRuntime);
    expect(runtime.id).toBe("opencode");
    expect(runtime.capabilities).toEqual({
      streaming: true,
      resumableSessions: true,
      structuredForms: true,
      cancellation: true,
    });
    runtime.close();
  });

  it("shares a single server across concurrent starts", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch(
      happyHandler([{ id: "m", type: "assistant", content: [{ text: "ok" }] }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const [first, second] = await Promise.all([start(runtime), start(runtime)]);
    expect(first.sessionId).toBeTruthy();
    expect(second.sessionId).toBeTruthy();
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

  it("marks the run failed when execution fails", async () => {
    announceServer(proc);
    const base = hangingHandler();
    const enc = new TextEncoder();
    const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "GET" && path === "/api/event") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            controller.enqueue(
              enc.encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`),
            );
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (method === "POST" && path.endsWith("/prompt")) {
        queueMicrotask(() => {
          const frame = enc.encode(
            `data: ${JSON.stringify({
              type: "session.execution.failed",
              data: { sessionID: "sess-1" },
            })}\n\n`,
          );
          for (const c of controllers) {
            try {
              c.enqueue(frame);
            } catch {
              /* closed */
            }
          }
        });
        return noContent();
      }
      return base(method, path);
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
    const base = happyHandler([{ id: "m-new", type: "assistant", content: [{ text: "ok" }] }]);
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "POST" && path === "/api/session") {
        return jsonResponse({ data: { id: "wrapped" } });
      }
      return base(method, path);
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
    const { fn: fetchMock } = makeFetch(happyHandler([{ type: "idle", outcome: "succeeded" }]));
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
      return hangingHandler()(method, path);
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
      return hangingHandler()(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { timeoutMs: 5 });
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(124);
  });

  it("switches the session model when the run requests one", async () => {
    announceServer(proc);
    const { fn: fetchMock, calls } = makeFetch(
      happyHandler([
        { id: "m-idle", type: "idle", outcome: "succeeded" },
        { id: "m-asst", type: "assistant", content: [{ type: "text", text: "hello" }] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, {
      model: { providerID: "opencode", id: "glm-5.3-flash-free" },
    });
    expect(handle.sessionId).toBe("sess-1");

    const switchCall = calls.find((c) => c.path === "/api/session/sess-1/model");
    expect(switchCall?.method).toBe("POST");
    expect(switchCall?.init?.body).toBe(
      JSON.stringify({ model: { id: "glm-5.3-flash-free", providerID: "opencode" } }),
    );
    // The switch must happen before the prior-message snapshot, so the
    // model-selection bookkeeping message is scoped to this run (issue #21).
    const switchIndex = calls.findIndex((c) => c.path.endsWith("/model"));
    const snapshotIndex = calls.findIndex((c) => c.path.endsWith("/message"));
    expect(switchIndex).toBeLessThan(snapshotIndex);
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(0);
  });

  it("does not switch the model when no model is requested", async () => {
    announceServer(proc);
    const { fn: fetchMock, calls } = makeFetch(
      happyHandler([{ type: "idle", outcome: "succeeded" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime);
    await drain(runtime, handle);
    expect(calls.some((c) => c.path.endsWith("/model"))).toBe(false);
  });

  it("warns and continues when the model switch fails", async () => {
    announceServer(proc);
    const happy = happyHandler([
      { id: "m-idle", type: "idle", outcome: "succeeded" },
      { id: "m-asst", type: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "POST" && path.endsWith("/model")) {
        return jsonResponse({ error: "ModelNotFoundError" }, 400);
      }
      return happy(method, path);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const handle = await start(runtime, { model: { providerID: "ghost", id: "gone" } });
    const result = await Effect.runPromise(runtime.getResult(handle));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("hello");

    const events = await collectEvents(runtime.streamEvents(handle));
    const progress = events.filter((e) => e._tag === "progress") as Array<
      Extract<RuntimeEvent, { _tag: "progress" }>
    >;
    expect(progress.some((e) => e.message.includes("Model ghost/gone"))).toBe(true);
  });

  it("listModels maps the /api/model catalog", async () => {
    announceServer(proc);
    const { fn: fetchMock } = makeFetch((method, path) => {
      if (method === "GET" && path === "/api/model") {
        return jsonResponse({
          location: { directory: "/tmp" },
          data: [
            { id: "m1", modelID: "m1", providerID: "p1", name: "Model One", enabled: true },
            {
              id: "m2",
              modelID: "m2",
              providerID: "p2",
              name: "Model Two",
              enabled: true,
              status: "beta",
            },
            { id: "m3", modelID: "m3", providerID: "p3", name: "", enabled: false },
          ],
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new OpenCodeRuntime();
    const models = await Effect.runPromise(runtime.listModels());
    expect(models).toHaveLength(3);
    expect(models).toEqual([
      { providerID: "p1", id: "m1", name: "Model One", enabled: true },
      { providerID: "p2", id: "m2", name: "Model Two", enabled: true, status: "beta" },
      { providerID: "p3", id: "m3", name: "m3", enabled: false },
    ]);
  });
});
