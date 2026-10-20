/* eslint-disable @typescript-eslint/no-this-alias */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from "node:child_process";
import { Effect, Stream } from "effect";
import type {
  AgentRuntime,
  RunHandle,
  RunRequest,
  RunResult,
  RuntimeError,
  RuntimeCapabilities,
  RuntimeEvent,
} from "@bebots/application";

interface ServerInfo {
  readonly process: ReturnType<typeof spawn>;
  readonly url: string;
  readonly password: string;
}

interface RunState {
  readonly runId: string;
  sessionId?: string;
  readonly events: RuntimeEvent[];
  readonly waiters: Array<() => void>;
  done: boolean;
  result?: RunResult;
  cancelled: boolean;
  timeoutHandle?: NodeJS.Timeout;
}

function makeError(message: string, cause?: unknown): RuntimeError {
  return { _tag: "RuntimeError", message, cause };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OpenCodeRuntimeOptions {
  readonly command?: string;
  readonly baseDirectory?: string;
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly id = "opencode";
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    resumableSessions: true,
    cancellation: true,
  };

  private readonly command: string;
  private readonly baseDirectory: string;
  private server: ServerInfo | null = null;
  private serverStarting: Promise<ServerInfo> | null = null;
  private readonly runs = new Map<string, RunState>();

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.command = options.command ?? "opencode";
    this.baseDirectory = options.baseDirectory ?? process.cwd();
  }

  private async ensureServer(): Promise<ServerInfo> {
    if (this.server) return this.server;
    if (this.serverStarting) return this.serverStarting;
    const promise = (async () => {
      const proc = spawn(this.command, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
        cwd: this.baseDirectory,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let password = "";
      let url = "";
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out starting opencode server")),
          30_000,
        );
        const onData = (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          const urlMatch = stdout.match(/server listening on (http:\/\/[^\s]+)/);
          const pwMatch = stdout.match(/server password (\S+)/);
          if (urlMatch) url = urlMatch[1] ?? url;
          if (pwMatch) password = pwMatch[1] ?? password;
          if (url && password) {
            clearTimeout(timeout);
            resolve();
          }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        proc.on("exit", (code) => {
          if (!url || !password) {
            clearTimeout(timeout);
            reject(new Error(`opencode server exited early with code ${code}`));
          }
        });
      });
      const info: ServerInfo = { process: proc, url, password };
      this.server = info;
      return info;
    })();
    this.serverStarting = promise;
    try {
      const info = await promise;
      this.serverStarting = null;
      return info;
    } catch (e) {
      this.serverStarting = null;
      throw e;
    }
  }

  private authHeader(password: string): string {
    return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  }

  private async request<T>(
    server: ServerInfo,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader(server.password),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${server.url}${path}`, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenCode API ${method} ${path} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json()) as { data?: T };
    return json && typeof json === "object" && "data" in json
      ? (json as { data: T }).data
      : (json as T);
  }

  private notify(state: RunState): void {
    const waiters = [...state.waiters];
    state.waiters.length = 0;
    for (const w of waiters) w();
  }

  startRun(request: RunRequest): Effect.Effect<RunHandle, RuntimeError> {
    const self = this;
    return Effect.tryPromise({
      try: async () => {
        const server = await self.ensureServer();
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Resolve or create session. When the stored runtime session is gone
        // (expired/purged), start a genuinely NEW session transparently —
        // never re-create the old id (PLAN §6.4).
        let sessionId: string | undefined = request.sessionId;
        if (sessionId) {
          try {
            await self.request(server, "GET", `/api/session/${sessionId}`);
          } catch {
            const created = await self.request<{ id: string }>(server, "POST", "/api/session", {
              title: "bebots run",
              location: { directory: request.workingDirectory },
            });
            sessionId = created.id;
          }
        } else {
          const created = await self.request<{ id: string }>(server, "POST", "/api/session", {
            title: "bebots run",
            location: { directory: request.workingDirectory },
          });
          sessionId = created.id;
        }

        const state: RunState = {
          runId,
          sessionId,
          events: [{ _tag: "started", at: new Date() }],
          waiters: [],
          done: false,
          cancelled: false,
        };
        this.runs.set(runId, state);
        this.notify(state);

        // Snapshot the messages already in the session BEFORE prompting. On a
        // resumed session this run must only report its own messages — the
        // first assistant reply in the whole history belongs to the original
        // run (found via #20's diagnosis: every resumed run re-answered with
        // the first reply the session ever produced).
        const priorMessages = await self.request<unknown[]>(
          server,
          "GET",
          `/api/session/${sessionId}/message`,
        );
        const prior = Array.isArray(priorMessages)
          ? priorMessages
          : ((priorMessages as { data?: unknown[] })?.data ?? []);
        const priorIds = new Set(prior.map((m) => String((m as { id?: unknown })?.id)));

        // Send prompt.
        await self.request(server, "POST", `/api/session/${sessionId}/prompt`, {
          text: request.prompt,
        });

        // Background completion polling.
        const poll = async () => {
          const deadline = Date.now() + request.timeoutMs;
          try {
            while (!state.cancelled && Date.now() < deadline) {
              await sleep(500);
              if (state.cancelled) break;
              const msgs = await self.request<unknown[]>(
                server,
                "GET",
                `/api/session/${sessionId}/message`,
              );
              const list = Array.isArray(msgs)
                ? msgs
                : ((msgs as { data?: unknown[] })?.data ?? []);
              // Only this run's messages: everything already in the session
              // before the prompt belongs to earlier runs (issue #21) — the
              // first assistant reply in session history is the original
              // run's, not this run's.
              const fresh = (list as any[]).filter((m: any) => !priorIds.has(String(m?.id)));
              const idle = fresh.find((m: any) => m?.type === "idle");
              if (idle) {
                const assistant = fresh.find((m: any) => m?.type === "assistant");
                // Only the assistant's actual text — reasoning parts are
                // internal model thoughts, not chat content.
                const text =
                  assistant?.content
                    ?.filter((c: any) => c?.type === undefined || c?.type === "text")
                    .map((c: any) => c?.text)
                    .filter(Boolean)
                    .join("\n") ?? "";
                if (!state.cancelled) {
                  state.events.push({ _tag: "completed", summary: text });
                  state.result = {
                    exitCode: idle.outcome === "succeeded" ? 0 : 1,
                    summary: text,
                    sessionId,
                  };
                }
                state.done = true;
                this.notify(state);
                return;
              }
            }
            if (state.cancelled) {
              // attempt interrupt
              try {
                await self.request(
                  server,
                  "POST",
                  `/api/session/${sessionId}/interrupt?resume=false`,
                  {},
                );
              } catch {
                /* ignore */
              }
              state.events.push({ _tag: "failed", error: makeError("Cancelled") });
              state.result = { exitCode: 130, summary: "cancelled", sessionId };
              state.done = true;
              this.notify(state);
              return;
            }
            // timeout
            try {
              await self.request(
                server,
                "POST",
                `/api/session/${sessionId}/interrupt?resume=false`,
                {},
              );
            } catch {
              /* ignore */
            }
            state.events.push({ _tag: "failed", error: makeError("Timed out") });
            state.result = { exitCode: 124, summary: "timed out", sessionId };
            state.done = true;
            this.notify(state);
          } catch (e: unknown) {
            const err = makeError(e instanceof Error ? e.message : String(e));
            state.events.push({ _tag: "failed", error: err });
            state.result = { exitCode: 1, summary: err.message, sessionId };
            state.done = true;
            this.notify(state);
          }
        };
        void poll();

        return { runId, sessionId };
      },
      catch: (cause: unknown) => makeError("Failed to start run", cause),
    });
  }

  cancelRun(handle: RunHandle): Effect.Effect<void, RuntimeError> {
    const self = this;
    return Effect.tryPromise({
      try: async () => {
        const state = self.runs.get(handle.runId);
        if (!state) return;
        state.cancelled = true;
        if (state.sessionId) {
          const server = await self.ensureServer();
          try {
            await self.request(
              server,
              "POST",
              `/api/session/${state.sessionId}/interrupt?resume=false`,
              {},
            );
          } catch {
            /* ignore */
          }
        }
        self.notify(state);
      },
      catch: (cause: unknown) => makeError("Failed to cancel run", cause),
    });
  }

  streamEvents(handle: RunHandle): Stream.Stream<RuntimeEvent, RuntimeError> {
    const state = this.runs.get(handle.runId);
    if (!state) {
      return Stream.empty as Stream.Stream<RuntimeEvent, RuntimeError>;
    }
    const runState = state as RunState;
    async function* gen() {
      let index = 0;
      while (true) {
        while (index < runState.events.length) {
          yield runState.events[index++];
        }
        if (runState.done) break;
        await new Promise<void>((resolve) => {
          runState.waiters.push(resolve);
        });
      }
    }
    return Stream.fromAsyncIterable(gen(), (e: unknown) => e as RuntimeError) as Stream.Stream<
      RuntimeEvent,
      RuntimeError
    >;
  }

  getResult(handle: RunHandle): Effect.Effect<RunResult, RuntimeError> {
    const self = this;
    return Effect.tryPromise({
      try: async () => {
        const state = self.runs.get(handle.runId);
        if (!state) throw new Error("Unknown run");
        const runState = state as RunState;
        while (!runState.done) {
          await new Promise<void>((resolve) => {
            runState.waiters.push(resolve);
          });
        }
        return runState.result!;
      },
      catch: (cause: unknown) =>
        (cause as RuntimeError)?._tag === "RuntimeError"
          ? (cause as RuntimeError)
          : makeError("Failed to get result", cause),
    });
  }
  close(): void {
    if (this.server) {
      try {
        this.server.process.kill();
      } catch {
        // ignore
      }
      this.server = null;
    }
  }
}

export function createOpenCodeRuntime(options?: OpenCodeRuntimeOptions): OpenCodeRuntime {
  return new OpenCodeRuntime(options);
}

// Aliases for compatibility
export const OpenCodeAdapter = OpenCodeRuntime;
