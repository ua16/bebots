import { Effect, Stream } from "effect";
import type { BotId, ModelRef } from "@bebots/domain";

/**
 * Capability flags a runtime may or may not support. Differences between
 * adapters must be represented explicitly rather than assumed.
 */
export interface RuntimeCapabilities {
  readonly streaming: boolean;
  readonly resumableSessions: boolean;
  readonly cancellation: boolean;
}

export interface RuntimeError {
  readonly _tag: "RuntimeError";
  readonly message: string;
  readonly cause?: unknown;
}

export interface RunRequest {
  readonly botId: BotId;
  readonly workingDirectory: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly timeoutMs: number;
  /** Model override (bot's model or the app default) the run should use. */
  readonly model?: ModelRef;
}

export interface RunHandle {
  readonly runId: string;
  readonly sessionId?: string;
}

export type RuntimeEvent =
  | { readonly _tag: "started"; readonly at: Date }
  | { readonly _tag: "progress"; readonly message: string }
  | { readonly _tag: "output"; readonly chunk: string }
  | { readonly _tag: "completed"; readonly summary: string }
  | { readonly _tag: "failed"; readonly error: RuntimeError };

export interface RunResult {
  readonly exitCode: number;
  readonly summary: string;
  readonly sessionId?: string;
}

/** Slimmed-down model info for pickers; mirrors OpenCode's `GET /api/model`. */
export interface RuntimeModelInfo {
  readonly providerID: string;
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly status?: "alpha" | "beta" | "deprecated" | "active";
}

/**
 * Stable internal runtime adapter contract. All adapters must implement
 * this interface; lifecycle tests are shared across adapters.
 */
export interface AgentRuntime {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;

  startRun(request: RunRequest): Effect.Effect<RunHandle, RuntimeError>;

  cancelRun(handle: RunHandle): Effect.Effect<void, RuntimeError>;

  streamEvents(handle: RunHandle): Stream.Stream<RuntimeEvent, RuntimeError>;

  getResult(handle: RunHandle): Effect.Effect<RunResult, RuntimeError>;

  /**
   * Models the runtime can run (for pickers and validation). Optional —
   * runtimes without a model catalog may omit it.
   */
  listModels?(): Effect.Effect<readonly RuntimeModelInfo[], RuntimeError>;
}
