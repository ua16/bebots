export * from "./attachment.js";
export * from "./avatar.js";
export * from "./form.js";
export * from "./prompt-notes.js";
export * from "./schedule.js";
export * from "./schemas.js";

import type { FormId, PendingRunInput } from "./form.js";

import type { BotAvatar } from "./avatar.js";

export type BotId = string & { readonly __brand: "BotId" };

export function asBotId(value: string): BotId {
  if (value.trim().length === 0) {
    throw new Error("BotId cannot be empty");
  }
  return value as BotId;
}

export type BotStatus = "active" | "archived";

/**
 * Reference to an OpenCode model, mirroring the shape of the
 * `POST /api/session/{id}/model` switch body (`Model.Ref`). `id` is the
 * model's id within the provider (e.g. `gpt-5.1`), not a full composite.
 */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
}

/** Serialize a ModelRef for a persisted TEXT column. `null` becomes `''`. */
export function serializeModelRef(ref: ModelRef | null | undefined): string {
  if (!ref) return "";
  return JSON.stringify({ providerID: ref.providerID, id: ref.id });
}

import { Schema } from "effect";
import { ModelRefSchema } from "./schemas.js";

/** Parse a persisted TEXT column back into a ModelRef. Anything invalid becomes `null`. */
export function parseModelRef(value: string | null | undefined): ModelRef | null {
  if (!value) return null;
  try {
    const parsed = Schema.decodeUnknownSync(ModelRefSchema)(JSON.parse(value) as unknown);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Result of validating untrusted model-ref input: the normalized (trimmed)
 * value, or which field failed and why.
 */
export type ValidatedModelRef =
  | { readonly valid: true; readonly value: ModelRef | null | undefined }
  | { readonly valid: false; readonly field: string; readonly message: string };

/**
 * Validate untrusted model-ref input (an HTTP request body field or a decoded
 * persisted value). `undefined` means "field not sent" and `null` means
 * "explicitly clear", so partial-update callers can distinguish keep from
 * clear; a present value must be `{ providerID, id }` with non-empty strings.
 */
export function validateModelRef(model: unknown): ValidatedModelRef {
  if (model === undefined || model === null) {
    return { valid: true, value: model };
  }
  if (typeof model !== "object") {
    return { valid: false, field: "model", message: "Model must be an object" };
  }
  try {
    const value = Schema.decodeUnknownSync(ModelRefSchema)(model);
    return { valid: true, value };
  } catch (e) {
    const issue = (e as { issue?: { _tag?: string; path?: unknown[]; issues?: unknown[] } }).issue;
    const path = Array.isArray(issue?.path) ? issue.path : [];
    const field =
      path[0] === "providerID" ? "model.providerID" : path[0] === "id" ? "model.id" : "model";
    const message =
      path[0] === "providerID"
        ? "Provider id cannot be empty"
        : path[0] === "id"
          ? "Model id cannot be empty"
          : "Model must be an object";
    return { valid: false, field, message };
  }
}

export interface Bot {
  readonly id: BotId;
  readonly name: string;
  readonly description: string;
  readonly persona: string;
  readonly status: BotStatus;
  /** Per-bot model override; `null`/absent means "use the app default, if any". */
  readonly model?: ModelRef | null;
  readonly avatar: BotAvatar;
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
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["awaiting_input", "succeeded", "failed", "cancelled", "timed_out"],
  awaiting_input: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/** Statuses that hold an in-flight concurrency slot. */
export const ACTIVE_RUN_STATUSES = ["queued", "running", "awaiting_input"] as const;

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

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
  /**
   * The bot whose OpenCode session this is; `null`/absent for legacy rows
   * recorded before per-bot scoping. A run must only resume a session that
   * belongs to its own bot — sessions are scoped per (conversation, bot).
   */
  readonly botId?: string | null;
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
  readonly pendingFormId?: FormId;
  readonly inputDeadlineAt?: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function pendingInputOf(run: Run): PendingRunInput | null {
  if (run.status !== "awaiting_input" || run.pendingFormId === undefined) return null;
  if (run.inputDeadlineAt === undefined) return null;
  return { formId: run.pendingFormId, inputDeadlineAt: run.inputDeadlineAt };
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
