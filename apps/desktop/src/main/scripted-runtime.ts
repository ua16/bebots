// Scripted runtime standing in for `@bebots/runtime-opencode`, wired in with
// the same `vi.mock` seam as `fake-runtime.ts`. Pops one `RunScript` per run
// and records every `RunRequest` the app sent.
//
// The store lives on `globalThis` so scripts and recordings survive
// `vi.resetModules()` between boots (`reboot()`): a fresh runtime instance,
// same state — like an app restart keeping its configuration.

import { Effect, Stream } from "effect";
import type {
  RunHandle,
  RunRequest,
  RunResult,
  RuntimeError,
  RuntimeEvent,
} from "@bebots/application";

export type RunScript = {
  /** Final summary; for conversation runs it becomes the bot reply. */
  readonly summary?: string;
  readonly events?: readonly RuntimeEvent[];
  readonly exitCode?: number;
  /** Prefix for a fresh runtime session id when the request carries none. */
  readonly sessionPrefix?: string;
};

type PendingRun = { readonly script: RunScript; readonly sessionId: string };

type ScriptedStore = {
  scripts: RunScript[];
  pending: Map<string, PendingRun>;
  requests: RunRequest[];
  cancellations: RunHandle[];
  runsStarted: number;
};

const global = globalThis as typeof globalThis & {
  __bebotsScriptedRuntimeStore?: ScriptedStore;
};

export const scriptedStore: ScriptedStore = (global.__bebotsScriptedRuntimeStore ??= {
  scripts: [],
  pending: new Map(),
  requests: [],
  cancellations: [],
  runsStarted: 0,
});

const DEFAULT_SUMMARY = "ok";

export class ScriptedRuntime {
  readonly id = "scripted";
  readonly capabilities = {
    streaming: true,
    resumableSessions: true,
    cancellation: true,
  };

  constructor(_options?: { extraLogs?: boolean }) {}

  startRun(request: RunRequest): Effect.Effect<RunHandle, RuntimeError> {
    const script = scriptedStore.scripts.shift() ?? {};
    scriptedStore.requests.push(request);
    const runId = `rt-${++scriptedStore.runsStarted}`;
    const sessionId =
      request.sessionId ?? `${script.sessionPrefix ?? "sess"}-${scriptedStore.runsStarted}`;
    scriptedStore.pending.set(runId, { script, sessionId });
    return Effect.succeed({ runId, sessionId });
  }

  cancelRun(handle: RunHandle): Effect.Effect<void, RuntimeError> {
    scriptedStore.cancellations.push(handle);
    return Effect.void;
  }

  streamEvents(handle: RunHandle): Stream.Stream<RuntimeEvent, RuntimeError> {
    const pending = scriptedStore.pending.get(handle.runId);
    if (!pending) {
      return Stream.empty;
    }
    const summary = pending.script.summary ?? DEFAULT_SUMMARY;
    const events: RuntimeEvent[] = [
      { _tag: "started", at: new Date() },
      ...(pending.script.events ?? []),
    ];
    if ((pending.script.exitCode ?? 0) === 0) {
      events.push({ _tag: "completed", summary });
    } else {
      events.push({ _tag: "failed", error: { _tag: "RuntimeError", message: summary } });
    }
    return Stream.make(...events);
  }

  getResult(handle: RunHandle): Effect.Effect<RunResult, RuntimeError> {
    const pending = scriptedStore.pending.get(handle.runId);
    scriptedStore.pending.delete(handle.runId);
    const sessionId = pending?.sessionId ?? handle.sessionId;
    return Effect.succeed({
      exitCode: pending?.script.exitCode ?? 0,
      summary: pending?.script.summary ?? DEFAULT_SUMMARY,
      ...(sessionId !== undefined && { sessionId }),
    });
  }

  close() {}
}

export const OpenCodeRuntime = ScriptedRuntime;
export const createOpenCodeRuntime = () => new ScriptedRuntime();

export const scripted = {
  script(...queue: RunScript[]): void {
    scriptedStore.scripts.push(...queue);
  },
  requests(): readonly RunRequest[] {
    return scriptedStore.requests;
  },
  cancellations(): readonly RunHandle[] {
    return scriptedStore.cancellations;
  },
  reset(): void {
    scriptedStore.scripts.length = 0;
    scriptedStore.pending.clear();
    scriptedStore.requests.length = 0;
    scriptedStore.cancellations.length = 0;
    scriptedStore.runsStarted = 0;
  },
};
