import type { Bot, BotId } from "@bebots/domain";
import type { Run, RunId, RunStatus } from "@bebots/domain";
import type { Effect } from "effect";
import type { NotFoundError, RepositoryError, WorkspaceError } from "./errors.js";

export interface BotRepository {
  readonly create: (bot: Bot) => Effect.Effect<Bot, RepositoryError>;
  readonly findById: (id: BotId) => Effect.Effect<Bot | null, RepositoryError>;
  readonly findAll: (options?: {
    readonly includeArchived?: boolean;
  }) => Effect.Effect<readonly Bot[], RepositoryError>;
  readonly update: (bot: Bot) => Effect.Effect<Bot, RepositoryError | NotFoundError>;
  readonly delete: (id: BotId) => Effect.Effect<void, RepositoryError | NotFoundError>;
}

export interface RunRepository {
  readonly create: (run: Run) => Effect.Effect<Run, RepositoryError>;
  readonly findById: (id: RunId) => Effect.Effect<Run | null, RepositoryError>;
  readonly findAll: (options?: {
    readonly botId?: BotId;
    readonly status?: RunStatus;
    readonly limit?: number;
  }) => Effect.Effect<readonly Run[], RepositoryError>;
  readonly update: (run: Run) => Effect.Effect<Run, RepositoryError | NotFoundError>;
  readonly appendEvent: (
    runId: RunId,
    event: { readonly _tag: string; readonly [key: string]: unknown },
  ) => Effect.Effect<void, RepositoryError>;
  readonly listEvents: (
    runId: RunId,
  ) => Effect.Effect<readonly { readonly tag: string; readonly payload: unknown; readonly createdAt: number }[], RepositoryError>;
}

export interface Clock {
  readonly now: () => number;
}

export interface IdGenerator {
  readonly generate: () => string;
}

export interface BotWorkspace {
  readonly root: string;
  readonly ensureHome: (botId: BotId) => Effect.Effect<string, WorkspaceError>;
  readonly writePersona: (botId: BotId, persona: string) => Effect.Effect<void, WorkspaceError>;
  readonly homePath: (botId: BotId) => string;
}
