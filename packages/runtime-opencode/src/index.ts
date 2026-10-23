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
  RuntimeModelInfo,
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
  /** When true, log every request/response to the OpenCode API. */
  readonly extraLogs?: boolean;
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
  private readonly extraLogs: boolean;
  private server: ServerInfo | null = null;
  private serverStarting: Promise<ServerInfo> | null = null;
  private readonly runs = new Map<string, RunState>();

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.command = options.command ?? "opencode";
    this.baseDirectory = options.baseDirectory ?? process.cwd();
    this.extraLogs = options.extraLogs ?? false;
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
    if (this.extraLogs) {
      console.log(`[opencode] -> ${method} ${path}`, body !== undefined ? body : "");
    }
    const res = await fetch(`${server.url}${path}`, init);
    if (!res.ok) {
      const text = await res.text();
      if (this.extraLogs) {
        console.log(`[opencode] <- ${res.status} ${path}`, text);
      }
      throw new Error(`OpenCode API ${method} ${path} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) {
      if (this.extraLogs) {
        console.log(`[opencode] <- 204 ${path}`);
      }
      return undefined as T;
    }
    const json = (await res.json()) as { data?: T };
    if (this.extraLogs) {
      console.log(`[opencode] <- ${res.status} ${path}`, json);
    }
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

        // Apply the requested model (bot override or app default) on the
        // freshly created-or-resolved session, BEFORE the prior-message
        // snapshot below: the model switch records a message on the session,
        // and that snapshot must treat it as belonging to this run and not
        // the previous ones (issue #21 filtering). A failed switch (e.g. the
        // model id is no longer known) is surfaced as a progress event —
        // the run then proceeds on OpenCode's own default model rather
        // than failing outright.
        const requestedModel = request.model;
        if (requestedModel) {
          try {
            await self.request(
              server,
              "POST",
              `/api/session/${sessionId}/model`,
              { model: { id: requestedModel.id, providerID: requestedModel.providerID } },
            );
          } catch (e) {
            state.events.push({
              _tag: "progress",
              message: `Model ${requestedModel.providerID}/${requestedModel.id} could not be selected (${e instanceof Error ? e.message : String(e)}) — using the default model.`,
            });
          }
        }

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
        const priorIds = new Set(
          prior
            .map((m) => (m as { id?: unknown })?.id)
            .filter((id): id is string | number => id !== undefined && id !== null)
            .map((id) => String(id)),
        );
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
              const fresh = (list as any[]).filter((m: any) => {
                if (m?.id === undefined || m?.id === null) return true;
                return !priorIds.has(String(m.id));
              });
              const idle = fresh.find((m: any) => m?.type === "idle");
              // Some OpenCode builds surface completion on the assistant
              // message itself (finish) rather than a separate idle entry;
              // treat either as terminal so runs do not hang forever.
              const completedAssistant = fresh.find(
                (m: any) =>
                  m?.type === "assistant" &&
                  (m?.finish === "stop" || m?.finish === "length"),
              );
              const terminal = idle ?? (completedAssistant ? { outcome: "succeeded" } : undefined);
              if (terminal) {
                // Prefer the most recent assistant that actually carries text;
                // fall back to aggregating every fresh assistant's text parts
                // so a tool-only intermediate reply never blanks the summary.
                const assistants = fresh
                  .filter((m: any) => m?.type === "assistant")
                  .sort((a: any, b: any) => {
                    const ta = a?.time?.created ?? a?.createdAt ?? 0;
                    const tb = b?.time?.created ?? b?.createdAt ?? 0;
                    return (tb as number) - (ta as number);
                  });
                const extractText = (m: any): string => {
                  if (!m) return "";
                  if (Array.isArray(m.content)) {
                    return m.content
                      .filter((c: any) => c && (c.type === undefined || c.type === "text" || c.type === "output_text"))
                      .map((c: any) => c?.text ?? c?.content ?? c?.value)
                      .filter(Boolean)
                      .join("\n");
                  }
                  if (typeof m.content === "string") return m.content;
                  if (typeof m.text === "string") return m.text;
                  return "";
                };
                let text = "";
                for (const a of assistants) {
                  const t = extractText(a);
                  if (t.trim().length > 0) {
                    text = t;
                    break;
                  }
                }
                if (text.trim().length === 0) {
                  text = assistants.map(extractText).filter(Boolean).join("\n");
                }
                // Never post an empty summary for a succeeded run — the reply
                // loop requires non-empty content to record a bot reply.
                if (text.trim().length === 0 && (idle?.outcome === "succeeded" || !idle)) {
                  text = "(no response)";
                }
                const exitCode =
                  idle !== undefined
                    ? idle.outcome === "succeeded"
                      ? 0
                      : 1
                    : 0;
                if (!state.cancelled) {
                  state.events.push({ _tag: "completed", summary: text });
                  state.result = {
                    exitCode,
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
  listModels(): Effect.Effect<readonly RuntimeModelInfo[], RuntimeError> {
    const self = this;
    return Effect.tryPromise({
      try: async () => {
        const server = await self.ensureServer();
        const res = await self.request<{ data?: Array<Record<string, unknown>> }>(
          server,
          "GET",
          "/api/model",
        );
        const data = Array.isArray(res) ? res : (res?.data ?? []);
        return data
          .filter((m) => typeof m?.providerID === "string" && typeof m?.id === "string")
          .map((m) => {
            const base: RuntimeModelInfo = {
              providerID: m.providerID as string,
              id: m.id as string,
              name: typeof m.name === "string" && m.name.length > 0 ? m.name : (m.id as string),
              enabled: m.enabled !== false,
            };
            return typeof m.status === "string"
              ? {
                  ...base,
                  status: m.status as "alpha" | "beta" | "deprecated" | "active",
                }
              : base;
          });
      },
      catch: (cause: unknown) => makeError("Failed to list models", cause),
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
