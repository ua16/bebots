export type BotId = string & { readonly __brand: "BotId" };

export function asBotId(value: string): BotId {
  if (value.trim().length === 0) {
    throw new Error("BotId cannot be empty");
  }
  return value as BotId;
}

export type BotStatus = "active" | "archived";

export interface Bot {
  readonly id: BotId;
  readonly name: string;
  readonly description: string;
  readonly persona: string;
  readonly status: BotStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type RunId = string & { readonly __brand: "RunId" };

export function asRunId(value: string): RunId {
  if (value.trim().length === 0) {
    throw new Error("RunId cannot be empty");
  }
  return value as RunId;
}

export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ["manual", "schedule", "message", "task", "api"] as const;

export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export interface Run {
  readonly id: RunId;
  readonly botId: BotId;
  readonly triggerType: RunTrigger;
  readonly prompt: string;
  readonly status: RunStatus;
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

export const TASK_STATUSES = [
  "queued",
  "assigned",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "awaiting_approval",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["assigned", "cancelled"],
  assigned: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "awaiting_approval"],
  awaiting_approval: ["running", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ["approved", "rejected", "expired"],
  approved: [],
  rejected: [],
  expired: [],
};

export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}
