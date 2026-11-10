/** API shapes consumed by the renderer via `apiRequest` / the preload bridge. */

export interface ApiConversation {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly participants: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ApiMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly senderType: "human" | "bot" | "system";
  readonly senderId?: string | null | undefined;
  readonly content: string;
  readonly createdAt: number;
}

export interface ApiRun {
  readonly id: string;
  readonly botId: string;
  readonly status: string;
  readonly prompt: string;
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
  readonly createdAt: number;
}

export interface ApiModelRef {
  readonly providerID: string;
  readonly id: string;
}

export interface ApiSchedule {
  readonly id: string;
  readonly botId: string;
  readonly prompt: string;
  readonly trigger:
    | { kind: "interval"; everyMs: number }
    | { kind: "once"; at: number }
    | { kind: "cron"; expression: string; timezone: string };
  readonly enabled: boolean;
  /** The schedule's dedicated thread with the user (provisioned on first fire). */
  readonly conversationId?: string | null | undefined;
  readonly nextRunAt?: number | null | undefined;
  readonly lastRunAt?: number | null | undefined;
  readonly createdAt: number;
}

export interface ApiScheduleOccurrence {
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduledFor: number;
  readonly status: string;
  readonly runId?: string | null | undefined;
  readonly attempts: number;
  readonly error?: string | null | undefined;
}

export interface ApiModel {
  readonly providerID: string;
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}
