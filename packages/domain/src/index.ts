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

export type TaskId = string & { readonly __brand: "TaskId" };

export function asTaskId(value: string): TaskId {
  if (value.trim().length === 0) {
    throw new Error("TaskId cannot be empty");
  }
  return value as TaskId;
}

export type ActivityId = string & { readonly __brand: "ActivityId" };

export function asActivityId(value: string): ActivityId {
  if (value.trim().length === 0) {
    throw new Error("ActivityId cannot be empty");
  }
  return value as ActivityId;
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

export type ConversationId = string & { readonly __brand: "ConversationId" };

export function asConversationId(value: string): ConversationId {
  if (value.trim().length === 0) {
    throw new Error("ConversationId cannot be empty");
  }
  return value as ConversationId;
}

export type MessageId = string & { readonly __brand: "MessageId" };

export function asMessageId(value: string): MessageId {
  if (value.trim().length === 0) {
    throw new Error("MessageId cannot be empty");
  }
  return value as MessageId;
}

export type ConversationSessionId = string & { readonly __brand: "ConversationSessionId" };

export function asConversationSessionId(value: string): ConversationSessionId {
  if (value.trim().length === 0) {
    throw new Error("ConversationSessionId cannot be empty");
  }
  return value as ConversationSessionId;
}

export const CONVERSATION_KINDS = ["direct", "team"] as const;

export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export type DeliveryState = "pending" | "delivered" | "failed" | "sent" | "read";

export type ConversationSessionStatus = "active" | "expired" | "closed";

export type MessageSenderType = "human" | "bot" | "system";

export interface Conversation {
  readonly id: ConversationId;
  readonly kind: ConversationKind;
  readonly title: string;
  readonly participants: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly senderType: MessageSenderType;
  readonly senderId?: string | null;
  readonly content: string;
  readonly replyTo?: MessageId;
  readonly threadId?: string;
  readonly deliveryState: DeliveryState;
  readonly createdAt: number;
}

export interface ConversationSession {
  readonly id: ConversationSessionId;
  readonly conversationId: ConversationId;
  /** Runtime session id this record mirrors; never the source of truth for bot identity. */
  readonly runtimeSessionId: string;
  readonly lastUsedAt: number;
  readonly status: ConversationSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Run {
  readonly id: RunId;
  readonly botId: BotId;
  readonly triggerType: RunTrigger;
  readonly prompt: string;
  readonly status: RunStatus;
  readonly sessionId?: string;
  readonly conversationId?: ConversationId;
  readonly conversationSessionId?: ConversationSessionId;
  readonly taskId?: TaskId;
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

export interface Task {
  readonly id: TaskId;
  readonly requester: string | null;
  readonly assignee: string;
  readonly description: string;
  readonly inputRefs: readonly string[];
  readonly priority: number;
  readonly status: TaskStatus;
  readonly deadline?: number;
  readonly resultRunId?: RunId;
  readonly resultSummary?: string;
  readonly depth: number;
  readonly idempotencyKey?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ActivityEvent {
  readonly id: ActivityId;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorId?: string | null;
  readonly payload?: unknown;
  readonly createdAt: number;
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
