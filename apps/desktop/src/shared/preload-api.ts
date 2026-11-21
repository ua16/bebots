import type { BotAvatar } from "@bebots/domain";

export interface BebotsModelRef {
  readonly providerID: string;
  readonly id: string;
}

export type BebotsBotAvatar = BotAvatar;

export interface BebotsBot {
  readonly id: string;
  readonly homePath: string;
  readonly name: string;
  readonly description: string;
  readonly persona: string;
  readonly status: "active" | "archived";
  /** Per-bot model override; null/absent = app default (if set) → opencode default. */
  readonly model?: BebotsModelRef | null;
  readonly avatar: BebotsBotAvatar;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BebotsPreloadApi {
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
  };
  readonly workspace: {
    readonly getRoot: () => Promise<string>;
  };
  /**
   * Coordinates of the local HTTP API (the single business-logic path for the
   * renderer — IPC is for Electron-specific needs only, per PLAN §4).
   */
  readonly apiEndpoint: () => Promise<{
    readonly url: string;
    readonly token: string;
  } | null>;
  readonly bots: {
    readonly list: (includeArchived?: boolean) => Promise<readonly BebotsBot[]>;
    readonly get: (id: string) => Promise<BebotsBot | null>;
    readonly create: (input: {
      readonly name: string;
      readonly description?: string;
      readonly persona?: string;
      readonly model?: BebotsModelRef | null;
      readonly avatar?: BebotsBotAvatar;
    }) => Promise<BebotsBot>;
    readonly update: (
      id: string,
      input: {
        readonly name?: string;
        readonly description?: string;
        readonly persona?: string;
        readonly model?: BebotsModelRef | null;
        readonly avatar?: BebotsBotAvatar;
      },
    ) => Promise<BebotsBot>;
    readonly archive: (id: string) => Promise<BebotsBot>;
  };
  readonly runs: {
    readonly start: (input: {
      readonly botId: string;
      readonly prompt: string;
      readonly timeoutMs?: number;
      readonly sessionId?: string;
    }) => Promise<BebotsRun>;
    readonly get: (id: string) => Promise<BebotsRun | null>;
    readonly list: (options?: {
      readonly botId?: string;
      readonly status?: string;
      readonly limit?: number;
    }) => Promise<readonly BebotsRun[]>;
    readonly cancel: (id: string) => Promise<BebotsRun | null>;
    readonly events: (id: string) => Promise<readonly BebotsRunEvent[]>;
    readonly await: (id: string, timeoutMs?: number) => Promise<BebotsRun | null>;
  };
}

export interface BebotsRun {
  readonly id: string;
  readonly botId: string;
  readonly triggerType: string;
  readonly prompt: string;
  readonly status: string;
  readonly sessionId?: string;
  readonly timeoutMs: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BebotsRunEvent {
  readonly tag: string;
  readonly payload: unknown;
  readonly createdAt: number;
}
