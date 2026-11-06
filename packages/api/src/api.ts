import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiError,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";
import { Schema, SchemaGetter } from "effect";
import { ModelRefPatchSchema, ModelRefSchema, ScheduleTriggerSchema } from "@bebots/domain";

const IdParams = Schema.Struct({ id: Schema.String });
const LimitQuery = Schema.Struct({ limit: Schema.optional(Schema.Number) });

// Response schemas mirror the serialized domain objects the server has always
// emitted (full wire shape, so server-side encoding stays wire-identical and
// renderer consumers get compiler-checked types from the shared contract).

const ConversationResponse = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  participants: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const MessageResponse = Schema.Struct({
  id: Schema.String,
  conversationId: Schema.String,
  senderType: Schema.Literals(["human", "bot", "system"]),
  senderId: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.String,
  replyTo: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  deliveryState: Schema.Literals(["pending", "delivered", "failed", "sent", "read"]),
  createdAt: Schema.Number,
});

const PostMessageResponse = Schema.Struct({
  message: MessageResponse,
  runId: Schema.NullOr(Schema.String),
});

const RunResponse = Schema.Struct({
  id: Schema.String,
  botId: Schema.String,
  triggerType: Schema.Literals(["manual", "schedule", "message", "task", "api"]),
  prompt: Schema.String,
  status: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]),
  sessionId: Schema.optional(Schema.String),
  conversationId: Schema.optional(Schema.String),
  conversationSessionId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  timeoutMs: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  endedAt: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const ModelInfoResponse = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  status: Schema.optional(Schema.Literals(["alpha", "beta", "deprecated", "active"])),
});

const SettingsResponse = Schema.Struct({
  defaultModel: Schema.NullOr(ModelRefSchema),
});

const ScheduleResponse = Schema.Struct({
  id: Schema.String,
  botId: Schema.String,
  prompt: Schema.String,
  trigger: ScheduleTriggerSchema,
  enabled: Schema.Boolean,
  conversationId: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(Schema.String)),
  anchorAt: Schema.Number,
  nextRunAt: Schema.optional(Schema.NullOr(Schema.Number)),
  lastRunAt: Schema.optional(Schema.NullOr(Schema.Number)),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const OccurrenceResponse = Schema.Struct({
  id: Schema.String,
  scheduleId: Schema.String,
  scheduledFor: Schema.Number,
  status: Schema.Literals(["pending", "enqueued", "succeeded", "failed", "missed", "cancelled"]),
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  attempts: Schema.Number,
  error: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const BotBody = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  persona: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["active", "archived"])),
  model: Schema.optional(ModelRefPatchSchema),
});

const SettingsBody = Schema.Struct({
  defaultModel: Schema.optional(ModelRefPatchSchema),
});

const ScheduleBody = Schema.Struct({
  botId: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  trigger: Schema.optional(ScheduleTriggerSchema),
  enabled: Schema.optional(Schema.Boolean),
  conversationId: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(Schema.String)),
});

const ConversationBody = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["direct", "team"])),
  title: Schema.optional(Schema.String),
  participants: Schema.optional(Schema.Array(Schema.String)),
});

const MessageBody = Schema.Struct({
  senderType: Schema.optional(Schema.Literals(["human", "bot", "system"])),
  senderId: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.String),
  replyTo: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
});

const TaskBody = Schema.Struct({
  requester: Schema.optional(Schema.NullOr(Schema.String)),
  assignee: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputRefs: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Number),
  deadline: Schema.optional(Schema.Number),
  depth: Schema.optional(Schema.Number),
  idempotencyKey: Schema.optional(Schema.String),
  assign: Schema.optional(Schema.Boolean),
});

const ActivityBody = Schema.Struct({
  type: Schema.optional(Schema.String),
  entityType: Schema.optional(Schema.String),
  entityId: Schema.optional(Schema.String),
  actorId: Schema.optional(Schema.NullOr(Schema.String)),
  payload: Schema.optional(Schema.Unknown),
});

const RunBody = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
  sessionId: Schema.optional(Schema.String),
  conversationId: Schema.optional(Schema.String),
});

const SessionBody = Schema.Struct({
  runtimeSessionId: Schema.optional(Schema.String),
  botId: Schema.optional(Schema.String),
});

const DelegateBody = Schema.Struct({
  requester: Schema.optional(Schema.NullOr(Schema.String)),
  assignee: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  assignees: Schema.optional(Schema.Array(Schema.String)),
  parallel: Schema.optional(Schema.Boolean),
});

function stripUndefined(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripUndefined);
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) {
      result[key] = stripUndefined(val);
    }
  }
  return result;
}

const U = Schema.Unknown.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((x: unknown) => x),
    encode: SchemaGetter.transform((x: unknown) => stripUndefined(x)),
  }),
);
const ApiError = [
  HttpApiError.BadRequest,
  HttpApiError.NotFound,
  HttpApiError.Unauthorized,
  HttpApiError.NotImplemented,
  HttpApiError.ServiceUnavailable,
  HttpApiError.InternalServerError,
];

const health = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/health", { success: U, error: ApiError }),
);

const token = HttpApiGroup.make("token").add(
  HttpApiEndpoint.get("token", "/api/v1/token", { success: U, error: ApiError }),
);

const models = HttpApiGroup.make("models").add(
  HttpApiEndpoint.get("models", "/api/v1/models", {
    success: Schema.Array(ModelInfoResponse),
    error: ApiError,
  }),
);

const settings = HttpApiGroup.make("settings").add(
  HttpApiEndpoint.get("getSettings", "/api/v1/settings", {
    success: SettingsResponse,
    error: ApiError,
  }),
  HttpApiEndpoint.put("putSettings", "/api/v1/settings", {
    payload: SettingsBody,
    success: SettingsResponse,
    error: ApiError,
  }),
);

const bots = HttpApiGroup.make("bots").add(
  HttpApiEndpoint.get("listBots", "/api/v1/bots", {
    query: Schema.Struct({ includeArchived: Schema.optional(Schema.Boolean) }),
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.post("createBot", "/api/v1/bots", {
    payload: BotBody,
    success: HttpApiSchema.status(201)(U),
    error: ApiError,
  }),
  HttpApiEndpoint.get("getBot", "/api/v1/bots/:id", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.patch("updateBot", "/api/v1/bots/:id", {
    params: IdParams,
    payload: BotBody,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.get("listBotRuns", "/api/v1/bots/:id/runs", {
    params: IdParams,
    success: Schema.Array(RunResponse),
    error: ApiError,
  }),
  HttpApiEndpoint.post("createBotRun", "/api/v1/bots/:id/runs", {
    params: IdParams,
    payload: RunBody,
    success: HttpApiSchema.status(201)(U),
    error: ApiError,
  }),
);

const runs = HttpApiGroup.make("runs").add(
  HttpApiEndpoint.get("getRun", "/api/v1/runs/:id", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.get("runEvents", "/api/v1/runs/:id/events", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.post("cancelRun", "/api/v1/runs/:id/cancel", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
);

const conversations = HttpApiGroup.make("conversations").add(
  HttpApiEndpoint.get("listConversations", "/api/v1/conversations", {
    success: Schema.Array(ConversationResponse),
    error: ApiError,
  }),
  HttpApiEndpoint.post("createConversation", "/api/v1/conversations", {
    payload: ConversationBody,
    success: HttpApiSchema.status(201)(ConversationResponse),
    error: ApiError,
  }),
  HttpApiEndpoint.get("getConversation", "/api/v1/conversations/:id", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.patch("updateConversation", "/api/v1/conversations/:id", {
    params: IdParams,
    payload: ConversationBody,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.delete("deleteConversation", "/api/v1/conversations/:id", {
    params: IdParams,
    success: HttpApiSchema.NoContent,
    error: ApiError,
  }),
  HttpApiEndpoint.get("listMessages", "/api/v1/conversations/:id/messages", {
    params: IdParams,
    success: Schema.Array(MessageResponse),
    error: ApiError,
  }),
  HttpApiEndpoint.post("postMessage", "/api/v1/conversations/:id/messages", {
    params: IdParams,
    payload: MessageBody,
    success: HttpApiSchema.status(201)(PostMessageResponse),
    error: ApiError,
  }),
  HttpApiEndpoint.get("listSessions", "/api/v1/conversations/:id/sessions", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.post("createSession", "/api/v1/conversations/:id/sessions", {
    params: IdParams,
    payload: SessionBody,
    success: HttpApiSchema.status(201)(U),
    error: ApiError,
  }),
);

const tasks = HttpApiGroup.make("tasks").add(
  HttpApiEndpoint.get("listTasks", "/api/v1/tasks", {
    query: Schema.Struct({
      requester: Schema.optional(Schema.String),
      assignee: Schema.optional(Schema.String),
      status: Schema.optional(
        Schema.Literals([
          "queued",
          "assigned",
          "running",
          "succeeded",
          "failed",
          "cancelled",
          "awaiting_approval",
        ]),
      ),
      limit: Schema.optional(Schema.Number),
    }),
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.post("createTask", "/api/v1/tasks", {
    payload: TaskBody,
    success: HttpApiSchema.status(201)(U),
    error: ApiError,
  }),
  HttpApiEndpoint.get("getTask", "/api/v1/tasks/:id", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.post("assignTask", "/api/v1/tasks/:id/assign", {
    params: IdParams,
    payload: U,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.post("cancelTask", "/api/v1/tasks/:id/cancel", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.post("delegateTask", "/api/v1/tasks/delegate", {
    payload: DelegateBody,
    success: HttpApiSchema.status(201)(U),
    error: ApiError,
  }),
);

const schedules = HttpApiGroup.make("schedules").add(
  HttpApiEndpoint.get("listSchedules", "/api/v1/schedules", {
    query: Schema.Struct({
      botId: Schema.optional(Schema.String),
      createdBy: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Number),
    }),
    success: Schema.Array(ScheduleResponse),
    error: ApiError,
  }),
  HttpApiEndpoint.post("createSchedule", "/api/v1/schedules", {
    payload: ScheduleBody,
    success: HttpApiSchema.status(201)(ScheduleResponse),
    error: ApiError,
  }),
  HttpApiEndpoint.get("getSchedule", "/api/v1/schedules/:id", {
    params: IdParams,
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.patch("updateSchedule", "/api/v1/schedules/:id", {
    params: IdParams,
    payload: ScheduleBody,
    success: ScheduleResponse,
    error: ApiError,
  }),
  HttpApiEndpoint.delete("deleteSchedule", "/api/v1/schedules/:id", {
    params: IdParams,
    success: HttpApiSchema.NoContent,
    error: ApiError,
  }),
  HttpApiEndpoint.get("listOccurrences", "/api/v1/schedules/:id/occurrences", {
    params: IdParams,
    query: LimitQuery,
    success: Schema.Array(OccurrenceResponse),
    error: ApiError,
  }),
);

const activity = HttpApiGroup.make("activity").add(
  HttpApiEndpoint.get("listActivity", "/api/v1/activity", {
    query: Schema.Struct({
      type: Schema.optional(Schema.String),
      entityType: Schema.optional(Schema.String),
      entityId: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Number),
    }),
    success: U,
    error: ApiError,
  }),
  HttpApiEndpoint.post("postActivity", "/api/v1/activity", {
    payload: ActivityBody,
    success: HttpApiSchema.status(201)(U),
    error: ApiError,
  }),
);

const control = HttpApiGroup.make("control").add(
  HttpApiEndpoint.get("controlStatus", "/api/v1/control/status", { success: U, error: ApiError }),
  HttpApiEndpoint.post("controlPause", "/api/v1/control/pause", { success: U, error: ApiError }),
  HttpApiEndpoint.post("controlResume", "/api/v1/control/resume", { success: U, error: ApiError }),
  HttpApiEndpoint.post("controlStop", "/api/v1/control/stop", { success: U, error: ApiError }),
);

const notes = HttpApiGroup.make("notes").add(
  HttpApiEndpoint.get("searchNotes", "/api/v1/notes/search", {
    query: Schema.Struct({
      q: Schema.optional(Schema.String),
      botId: Schema.optional(Schema.String),
    }),
    success: U,
    error: ApiError,
  }),
);

export class Api extends HttpApi.make("bebots")
  .add(
    health,
    token,
    models,
    settings,
    bots,
    runs,
    conversations,
    tasks,
    schedules,
    activity,
    control,
    notes,
  )
  .annotateMerge(OpenApi.annotations({ title: "Bebots Local API" })) {}
