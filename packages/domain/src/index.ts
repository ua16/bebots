/**
 * Domain primitives for bebots.
 *
 * This package owns domain types, branded IDs, and state-transition
 * rules. It must not depend on application, persistence, HTTP, Electron,
 * or any runtime adapter.
 */

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
