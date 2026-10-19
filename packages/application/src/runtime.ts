import { Effect, Stream } from "effect";
import type { BotId } from "@bebots/domain";

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
}
