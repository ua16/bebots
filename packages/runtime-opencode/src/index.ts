/* eslint-disable @typescript-eslint/no-this-alias */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from "node:child_process";
import { Effect, Stream } from "effect";
import type { Form, FormAnswers, FormField, FormId, FormOption } from "@bebots/domain";
import { asFormId } from "@bebots/domain";
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

type EventListener = (event: { type: string; data: any }) => void;

interface RunState {
  readonly runId: string;
  sessionId?: string;
  readonly events: RuntimeEvent[];
  readonly waiters: Array<() => void>;
  done: boolean;
  result?: RunResult;
  cancelled: boolean;
  /** Wall-clock ms still allowed for non-input work. */
  remainingTimeoutMs: number;
  /** When the current running (non-input) segment started. */
  segmentStartedAt: number | null;
  awaitingFormId: string | null;
  priorMessageIds: Set<string>;
  unsubscribe: (() => void) | null;
}

function makeError(message: string, cause?: unknown): RuntimeError {
  return { _tag: "RuntimeError", message, cause };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapOption(raw: any): FormOption {
  return {
    value: String(raw?.value ?? raw?.label ?? ""),
    label: String(raw?.label ?? raw?.value ?? "Option"),
    ...(typeof raw?.description === "string" ? { description: raw.description } : {}),
  };
}

function mapField(raw: any): FormField | null {
  if (!raw || typeof raw.key !== "string" || typeof raw.type !== "string") return null;
  const base = {
    key: raw.key,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.required === "boolean" ? { required: raw.required } : {}),
    ...(typeof raw.hidden === "boolean" ? { hidden: raw.hidden } : {}),
    ...(Array.isArray(raw.when)
      ? {
          when: raw.when
            .filter((w: any) => w && typeof w.key === "string" && (w.op === "eq" || w.op === "neq"))
            .map((w: any) => ({ key: w.key, op: w.op as "eq" | "neq", value: w.value })),
        }
      : {}),
  };
  switch (raw.type) {
    case "string":
      return {
        ...base,
        type: "string",
        ...(Array.isArray(raw.options) ? { options: raw.options.map(mapOption) } : {}),
        ...(typeof raw.custom === "boolean" ? { custom: raw.custom } : {}),
        ...(typeof raw.default === "string" ? { default: raw.default } : {}),
        ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
      };
    case "multiselect":
      return {
        ...base,
        type: "multiselect",
        options: Array.isArray(raw.options) ? raw.options.map(mapOption) : [],
        ...(typeof raw.custom === "boolean" ? { custom: raw.custom } : {}),
        ...(Array.isArray(raw.default) ? { default: raw.default.map(String) } : {}),
      };
    case "number":
      return {
        ...base,
        type: "number",
        ...(typeof raw.default === "number" ? { default: raw.default } : {}),
        ...(typeof raw.minimum === "number" ? { minimum: raw.minimum } : {}),
        ...(typeof raw.maximum === "number" ? { maximum: raw.maximum } : {}),
      };
    case "integer":
      return {
        ...base,
        type: "integer",
        ...(typeof raw.default === "number" ? { default: raw.default } : {}),
        ...(typeof raw.minimum === "number" ? { minimum: raw.minimum } : {}),
        ...(typeof raw.maximum === "number" ? { maximum: raw.maximum } : {}),
      };
    case "boolean":
      return {
        ...base,
        type: "boolean",
        ...(typeof raw.default === "boolean" ? { default: raw.default } : {}),
      };
    case "external":
      return {
        ...base,
        type: "external",
        url: typeof raw.url === "string" ? raw.url : "",
      };
    default:
      return null;
  }
}

function mapForm(raw: any): Form {
  const fields = (Array.isArray(raw?.fields) ? raw.fields : [])
    .map(mapField)
    .filter((f: FormField | null): f is FormField => f !== null);
  return {
    id: asFormId(String(raw.id)),
    sessionId: String(raw.sessionID ?? raw.sessionId ?? ""),
    title: typeof raw.title === "string" ? raw.title : "Input needed",
    fields,
    ...(raw.metadata && typeof raw.metadata === "object" ? { metadata: raw.metadata } : {}),
  };
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
    structuredForms: true,
  };

  private readonly command: string;
  private readonly baseDirectory: string;
  private readonly extraLogs: boolean;
  private server: ServerInfo | null = null;
  private serverStarting: Promise<ServerInfo> | null = null;
  private readonly runs = new Map<string, RunState>();
  private eventListeners = new Set<EventListener>();
  private eventLoop: Promise<void> | null = null;
  private eventAbort: AbortController | null = null;

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
      this.startEventLoop(info);
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

  private startEventLoop(server: ServerInfo): void {
    if (this.eventLoop) return;
    this.eventAbort = new AbortController();
    const abort = this.eventAbort;
    this.eventLoop = (async () => {
      while (!abort.signal.aborted) {
        try {
          const res = await fetch(`${server.url}/api/event`, {
            headers: {
              Authorization: this.authHeader(server.password),
              Accept: "text/event-stream",
            },
            signal: abort.signal,
          });
          if (!res.ok || !res.body) {
            await sleep(500);
            continue;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!abort.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n");
            buffer = parts.pop() ?? "";
            for (const line of parts) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payload) as { type?: string; data?: unknown };
                if (typeof parsed.type === "string") {
                  const event = { type: parsed.type, data: parsed.data ?? parsed };
                  for (const listener of this.eventListeners) listener(event);
                }
              } catch {
                /* ignore malformed frames */
              }
            }
          }
        } catch (e) {
          if (abort.signal.aborted) return;
          if (this.extraLogs) {
            console.log("[opencode] event stream error", e);
          }
          await sleep(500);
        }
      }
    })();
  }

  private subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private notify(state: RunState): void {
    const waiters = [...state.waiters];
    state.waiters.length = 0;
    for (const w of waiters) w();
  }

  private pushEvent(state: RunState, event: RuntimeEvent): void {
    state.events.push(event);
    this.notify(state);
  }

  private pauseTimeout(state: RunState): void {
    if (state.segmentStartedAt !== null) {
      const elapsed = Date.now() - state.segmentStartedAt;
      state.remainingTimeoutMs = Math.max(0, state.remainingTimeoutMs - elapsed);
      state.segmentStartedAt = null;
    }
  }

  private resumeTimeout(state: RunState): void {
    if (state.awaitingFormId === null && state.segmentStartedAt === null && !state.done) {
      state.segmentStartedAt = Date.now();
    }
  }

  private remainingMs(state: RunState): number {
    if (state.awaitingFormId !== null || state.segmentStartedAt === null) {
      return state.remainingTimeoutMs;
    }
    return Math.max(0, state.remainingTimeoutMs - (Date.now() - state.segmentStartedAt));
  }

  private async extractSummary(server: ServerInfo, state: RunState): Promise<string> {
    const sessionId = state.sessionId;
    if (!sessionId) return "(no response)";
    try {
      const msgs = await this.request<unknown[]>(
        server,
        "GET",
        `/api/session/${sessionId}/message`,
      );
      const list = Array.isArray(msgs) ? msgs : ((msgs as { data?: unknown[] })?.data ?? []);
      const fresh = (list as any[]).filter((m: any) => {
        if (m?.id === undefined || m?.id === null) return true;
        return !state.priorMessageIds.has(String(m.id));
      });
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
            .filter(
              (c: any) =>
                c && (c.type === undefined || c.type === "text" || c.type === "output_text"),
            )
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
      return text.trim().length > 0 ? text : "(no response)";
    } catch {
      return "(no response)";
    }
  }

  private async finishRun(
    server: ServerInfo,
    state: RunState,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
    summary?: string,
  ): Promise<void> {
    if (state.done) return;
    state.unsubscribe?.();
    state.unsubscribe = null;
    state.awaitingFormId = null;
    state.segmentStartedAt = null;
    const sessionId = state.sessionId;
    let text = summary;
    if (text === undefined && outcome === "succeeded") {
      text = await this.extractSummary(server, state);
    }
    const baseResult = {
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    if (outcome === "succeeded") {
      this.pushEvent(state, { _tag: "completed", summary: text ?? "(no response)" });
      state.result = { exitCode: 0, summary: text ?? "(no response)", ...baseResult };
    } else if (outcome === "cancelled") {
      this.pushEvent(state, { _tag: "failed", error: makeError("Cancelled") });
      state.result = { exitCode: 130, summary: "cancelled", ...baseResult };
    } else if (outcome === "timed_out") {
      this.pushEvent(state, { _tag: "failed", error: makeError("Timed out") });
      state.result = { exitCode: 124, summary: "timed out", ...baseResult };
    } else {
      this.pushEvent(state, { _tag: "failed", error: makeError(text ?? "Failed") });
      state.result = { exitCode: 1, summary: text ?? "failed", ...baseResult };
    }
    state.done = true;
    this.notify(state);
  }

  /** Backup when `form.created` was missed on the event stream. */
  private async reconcilePendingForm(server: ServerInfo, state: RunState): Promise<void> {
    if (state.done || state.cancelled || state.awaitingFormId !== null || !state.sessionId) return;
    try {
      const raw = await this.request<unknown>(
        server,
        "GET",
        `/api/session/${state.sessionId}/form`,
      );
      const list = Array.isArray(raw) ? raw : [];
      const pending = list.find(
        (item) => item && typeof (item as { id?: unknown }).id === "string",
      );
      if (!pending) return;
      this.handleNativeEvent(server, state, { type: "form.created", data: { form: pending } });
    } catch {
      /* ignore transient list failures */
    }
  }

  /** Backup when `session.execution.*` was missed on the event stream. */
  private async reconcileCompletion(server: ServerInfo, state: RunState): Promise<void> {
    if (state.done || state.cancelled || state.awaitingFormId !== null || !state.sessionId) return;
    try {
      const msgs = await this.request<unknown[]>(
        server,
        "GET",
        `/api/session/${state.sessionId}/message`,
      );
      const list = Array.isArray(msgs) ? msgs : ((msgs as { data?: unknown[] })?.data ?? []);
      const fresh = (list as any[]).filter((m: any) => {
        if (m?.id === undefined || m?.id === null) return true;
        return !state.priorMessageIds.has(String(m.id));
      });
      const idle = fresh.find((m: any) => m?.type === "idle");
      const completedAssistant = fresh.find(
        (m: any) => m?.type === "assistant" && (m?.finish === "stop" || m?.finish === "length"),
      );
      if (idle || completedAssistant) {
        await this.finishRun(
          server,
          state,
          idle !== undefined && idle.outcome !== "succeeded" ? "failed" : "succeeded",
        );
      }
    } catch {
      /* ignore */
    }
  }

  private handleNativeEvent(
    server: ServerInfo,
    state: RunState,
    event: { type: string; data: any },
  ): void {
    if (state.done || state.cancelled) return;
    const sessionId = state.sessionId;
    if (!sessionId) return;

    const eventSession =
      event.data?.sessionID ??
      event.data?.sessionId ??
      event.data?.form?.sessionID ??
      event.data?.form?.sessionId;

    if (event.type === "form.created") {
      const form = event.data?.form ?? event.data;
      if (!form || String(form.sessionID ?? form.sessionId) !== sessionId) return;
      const formId = String(form.id);
      state.awaitingFormId = formId;
      this.pauseTimeout(state);
      this.pushEvent(state, {
        _tag: "user_input_requested",
        formId: asFormId(formId),
        at: new Date(),
      });
      return;
    }

    if (event.type === "form.replied" || event.type === "form.cancelled") {
      const id = String(event.data?.id ?? "");
      if (eventSession && String(eventSession) !== sessionId) return;
      if (state.awaitingFormId && id && id !== state.awaitingFormId) return;
      if (state.awaitingFormId) {
        const formId = asFormId(state.awaitingFormId);
        state.awaitingFormId = null;
        this.resumeTimeout(state);
        this.pushEvent(state, {
          _tag: "user_input_resolved",
          formId,
          outcome: event.type === "form.replied" ? "answered" : "dismissed",
          at: new Date(),
        });
      }
      return;
    }

    const isExecEnd =
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted";
    if (isExecEnd) {
      if (String(eventSession) !== sessionId) return;
      void (async () => {
        if (event.type === "session.execution.succeeded") {
          await this.finishRun(server, state, "succeeded");
        } else if (event.type === "session.execution.interrupted" || state.cancelled) {
          await this.finishRun(server, state, "cancelled");
        } else {
          await this.finishRun(server, state, "failed", "execution failed");
        }
      })();
    }
  }

  startRun(request: RunRequest): Effect.Effect<RunHandle, RuntimeError> {
    const self = this;
    return Effect.tryPromise({
      try: async () => {
        const server = await self.ensureServer();
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
          remainingTimeoutMs: request.timeoutMs,
          segmentStartedAt: Date.now(),
          awaitingFormId: null,
          priorMessageIds: new Set(),
          unsubscribe: null,
        };
        this.runs.set(runId, state);
        this.notify(state);

        const requestedModel = request.model;
        if (requestedModel) {
          try {
            await self.request(server, "POST", `/api/session/${sessionId}/model`, {
              model: { id: requestedModel.id, providerID: requestedModel.providerID },
            });
          } catch (e) {
            state.events.push({
              _tag: "progress",
              message: `Model ${requestedModel.providerID}/${requestedModel.id} could not be selected (${e instanceof Error ? e.message : String(e)}) — using the default model.`,
            });
          }
        }

        const priorMessages = await self.request<unknown[]>(
          server,
          "GET",
          `/api/session/${sessionId}/message`,
        );
        const prior = Array.isArray(priorMessages)
          ? priorMessages
          : ((priorMessages as { data?: unknown[] })?.data ?? []);
        state.priorMessageIds = new Set(
          prior
            .map((m) => (m as { id?: unknown })?.id)
            .filter((id): id is string | number => id !== undefined && id !== null)
            .map((id) => String(id)),
        );

        state.unsubscribe = self.subscribe((event) => {
          self.handleNativeEvent(server, state, event);
        });

        await self.request(server, "POST", `/api/session/${sessionId}/prompt`, {
          text: request.prompt,
        });

        // Watch timeout, reconcile pending forms (SSE can miss frames in some
        // hosts), and fall back to message-based completion if events stall.
        void (async () => {
          try {
            let ticks = 0;
            while (!state.done && !state.cancelled) {
              if (state.awaitingFormId !== null) {
                await sleep(250);
                continue;
              }
              ticks += 1;
              if (ticks % 2 === 0) {
                await self.reconcilePendingForm(server, state);
              }
              if (ticks % 4 === 0) {
                await self.reconcileCompletion(server, state);
              }
              const left = self.remainingMs(state);
              if (left <= 0) {
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
                await self.finishRun(server, state, "timed_out");
                return;
              }
              await sleep(Math.min(500, left));
            }
            if (state.cancelled && !state.done) {
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
              await self.finishRun(server, state, "cancelled");
            }
          } catch (e: unknown) {
            if (!state.done) {
              await self.finishRun(
                server,
                state,
                "failed",
                e instanceof Error ? e.message : String(e),
              );
            }
          }
        })();

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
          if (state.awaitingFormId) {
            try {
              await self.request(
                server,
                "DELETE",
                `/api/session/${state.sessionId}/form/${state.awaitingFormId}`,
              );
            } catch {
              /* ignore */
            }
          }
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

  getForm(handle: RunHandle, formId: FormId): Effect.Effect<Form, RuntimeError> {
    const self = this;
    return Effect.tryPromise({
      try: async () => {
        const state = self.runs.get(handle.runId);
        if (!state?.sessionId) throw new Error("Unknown run or session");
        const server = await self.ensureServer();
        const raw = await self.request<any>(
          server,
          "GET",
          `/api/session/${state.sessionId}/form/${formId}`,
        );
        return mapForm(raw);
      },
      catch: (cause: unknown) => makeError("Failed to get form", cause),
    });
  }

  replyToForm(
    handle: RunHandle,
    formId: FormId,
    answers: FormAnswers,
  ): Effect.Effect<void, RuntimeError> {
    const self = this;
    return Effect.tryPromise({
      try: async () => {
        const state = self.runs.get(handle.runId);
        if (!state?.sessionId) throw new Error("Unknown run or session");
        const server = await self.ensureServer();
        await self.request(server, "POST", `/api/session/${state.sessionId}/form/${formId}/reply`, {
          answer: answers,
        });
      },
      catch: (cause: unknown) => makeError("Failed to reply to form", cause),
    });
  }

  dismissForm(handle: RunHandle, formId: FormId): Effect.Effect<void, RuntimeError> {
    const self = this;
    return Effect.tryPromise({
      try: async () => {
        const state = self.runs.get(handle.runId);
        if (!state?.sessionId) throw new Error("Unknown run or session");
        const server = await self.ensureServer();
        await self.request(server, "DELETE", `/api/session/${state.sessionId}/form/${formId}`);
      },
      catch: (cause: unknown) => makeError("Failed to dismiss form", cause),
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
    this.eventAbort?.abort();
    this.eventAbort = null;
    this.eventLoop = null;
    this.eventListeners.clear();
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
