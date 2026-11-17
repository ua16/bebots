import { Effect, Layer } from "effect";
import { HttpApiBuilder, HttpApiError, HttpApiScalar } from "effect/http-api";
import { HttpRouter, HttpServer } from "effect/http";
import { Api } from "./api.js";
import {
  asBotId,
  asRunId,
  asConversationId,
  validateModelRef,
  validateScheduleTrigger,
} from "@bebots/domain";
import type { ModelRef } from "@bebots/domain";
import type { RuntimeModelInfo } from "@bebots/application";
import {
  BotService,
  BotDeletionService,
  RunService,
  ConversationService,
  ConversationSessionService,
  ConversationRunCoordinator,
  TaskService,
  ScheduleService,
  ActivityService,
  AppSettingsService,
  NotFoundError,
  ValidationError,
} from "@bebots/application";

export interface ApiDeps {
  readonly botService: BotService;
  readonly botDeletion: BotDeletionService;
  readonly runService: RunService;
  readonly conversationService: ConversationService;
  readonly conversationSessionService: ConversationSessionService;
  readonly conversationCoordinator: ConversationRunCoordinator;
  readonly taskService: TaskService;
  readonly scheduleService: ScheduleService;
  readonly activityService: ActivityService;
  readonly settingsService: AppSettingsService;
  readonly token: string;
  readonly runtime: {
    readonly listModels?: () => Effect.Effect<readonly RuntimeModelInfo[], unknown>;
  } | null;
  readonly indexer: {
    readonly search: (
      query: string,
      botId?: ReturnType<typeof asBotId>,
    ) => Effect.Effect<readonly unknown[], unknown>;
  } | null;
  readonly ensureBotSetup: (botId: string) => Promise<void>;
}

function mapError(
  e: unknown,
): HttpApiError.BadRequest | HttpApiError.NotFound | HttpApiError.InternalServerError {
  if (e instanceof NotFoundError) return new HttpApiError.NotFound();
  if (e instanceof ValidationError) return new HttpApiError.BadRequest();
  // InternalServerError hides the cause from the client; it must not hide it
  // from the operator either, so unexpected service errors land in the log.
  console.error("API handler unexpected error:", e);
  return new HttpApiError.InternalServerError();
}

function normalizeModelInput(
  value: unknown,
): { readonly model?: ModelRef | null } | { readonly error: string } {
  const validated = validateModelRef(value);
  if (validated.valid) {
    return { model: validated.value ?? null };
  }
  return { error: `${validated.field}: ${validated.message}` };
}

export const makeRoutes = (deps: ApiDeps) => {
  const healthLayer = HttpApiBuilder.group(
    Api,
    "health",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        health: () => Effect.succeed({ status: "ok" }),
      });
    }),
  );

  const tokenLayer = HttpApiBuilder.group(
    Api,
    "token",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        token: () => Effect.succeed({ token: deps.token }),
      });
    }),
  );

  const modelsLayer = HttpApiBuilder.group(
    Api,
    "models",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        models: () => {
          const runtime = deps.runtime;
          if (!runtime || typeof runtime.listModels !== "function") {
            return Effect.fail(new HttpApiError.NotImplemented());
          }
          return runtime.listModels!().pipe(
            Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
          );
        },
      });
    }),
  );

  const settingsLayer = HttpApiBuilder.group(
    Api,
    "settings",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        getSettings: () =>
          deps.settingsService.getDefaultModel().pipe(
            Effect.map((defaultModel) => ({ defaultModel })),
            Effect.mapError(mapError),
          ),
        putSettings: ({ payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const normalized = normalizeModelInput(body.defaultModel);
            if ("error" in normalized) return yield* new HttpApiError.BadRequest();
            if (!("model" in normalized)) return yield* new HttpApiError.BadRequest();
            yield* deps.settingsService
              .setDefaultModel(normalized.model ?? null)
              .pipe(Effect.mapError(mapError));
            const defaultModel = yield* deps.settingsService
              .getDefaultModel()
              .pipe(Effect.mapError(mapError));
            return { defaultModel };
          }),
      });
    }),
  );

  const botsLayer = HttpApiBuilder.group(
    Api,
    "bots",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        listBots: ({ query }) =>
          deps.botService.listBots(query.includeArchived === true).pipe(Effect.mapError(mapError)),
        createBot: ({ payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const model = normalizeModelInput(body.model);
            if ("error" in model) return yield* new HttpApiError.BadRequest();
            const bot = yield* deps.botService
              .createBot({
                name: body.name ?? "New bot",
                ...(body.description !== undefined && { description: body.description }),
                ...(body.persona !== undefined && { persona: body.persona }),
                ...("model" in model && { model: model.model }),
              })
              .pipe(Effect.mapError(mapError));
            yield* Effect.tryPromise({
              try: () => deps.ensureBotSetup(String(bot.id)),
              catch: (e) => e,
            }).pipe(Effect.mapError(mapError));
            return bot;
          }),
        getBot: ({ params }) =>
          Effect.gen(function* () {
            const bot = yield* deps.botService
              .getBot(asBotId(params.id))
              .pipe(Effect.mapError(mapError));
            if (!bot) return yield* new HttpApiError.NotFound();
            return bot;
          }),
        updateBot: ({ params, payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const id = asBotId(params.id);
            const model = normalizeModelInput(body.model);
            if ("error" in model) return yield* new HttpApiError.BadRequest();
            const bot = yield* deps.botService
              .updateBot(id, {
                ...(body.name !== undefined && { name: body.name }),
                ...(body.description !== undefined && { description: body.description }),
                ...(body.persona !== undefined && { persona: body.persona }),
                ...(body.status !== undefined && { status: body.status }),
                ...("model" in model && { model: model.model }),
              })
              .pipe(Effect.mapError(mapError));
            yield* Effect.tryPromise({
              try: () => deps.ensureBotSetup(String(bot.id)),
              catch: (e) => e,
            }).pipe(Effect.mapError(mapError));
            return bot;
          }),
        deleteBot: ({ params }) =>
          deps.botDeletion
            .deleteBot(asBotId(params.id))
            .pipe(Effect.mapError(mapError), Effect.asVoid),
        listBotRuns: ({ params }) =>
          deps.runService.listRuns({ botId: asBotId(params.id) }).pipe(Effect.mapError(mapError)),
        createBotRun: ({ params, payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const id = asBotId(params.id);
            const run = yield* deps.runService
              .startRun({
                botId: id,
                prompt: body.prompt ?? "",
                ...(body.timeoutMs !== undefined && { timeoutMs: body.timeoutMs }),
                ...(body.sessionId !== undefined && { sessionId: body.sessionId }),
                ...(body.conversationId !== undefined && {
                  conversationId: asConversationId(body.conversationId),
                }),
                triggerType: "api",
              })
              .pipe(Effect.mapError(mapError));
            return run;
          }),
      });
    }),
  );

  const runsLayer = HttpApiBuilder.group(
    Api,
    "runs",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        getRun: ({ params }) =>
          Effect.gen(function* () {
            const run = yield* deps.runService
              .getRun(asRunId(params.id))
              .pipe(Effect.mapError(mapError));
            if (!run) return yield* new HttpApiError.NotFound();
            return run;
          }),
        runEvents: ({ params }) =>
          deps.runService.getRunEvents(asRunId(params.id)).pipe(Effect.mapError(mapError)),
        cancelRun: ({ params }) =>
          Effect.gen(function* () {
            const run = yield* deps.runService
              .cancelRun(asRunId(params.id))
              .pipe(Effect.mapError(mapError));
            if (!run) return yield* new HttpApiError.NotFound();
            return run;
          }),
      });
    }),
  );

  const conversationsLayer = HttpApiBuilder.group(
    Api,
    "conversations",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        listConversations: () =>
          deps.conversationService.listConversations().pipe(Effect.mapError(mapError)),
        createConversation: ({ payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const conv = yield* deps.conversationService
              .createConversation({
                ...(body.kind !== undefined && { kind: body.kind }),
                ...(body.title !== undefined && { title: body.title }),
                ...(body.participants !== undefined && { participants: body.participants }),
              })
              .pipe(Effect.mapError(mapError));
            return conv;
          }),
        getConversation: ({ params }) =>
          Effect.gen(function* () {
            const conv = yield* deps.conversationService
              .getConversation(params.id)
              .pipe(Effect.mapError(mapError));
            if (!conv) return yield* new HttpApiError.NotFound();
            return conv;
          }),
        updateConversation: ({ params, payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const conv = yield* deps.conversationService
              .updateConversation(params.id, {
                ...(body.kind !== undefined && { kind: body.kind }),
                ...(body.title !== undefined && { title: body.title }),
                ...(body.participants !== undefined && { participants: body.participants }),
              })
              .pipe(Effect.mapError(mapError));
            return conv;
          }),
        deleteConversation: ({ params }) =>
          deps.conversationCoordinator
            .deleteConversation(params.id)
            .pipe(Effect.mapError(mapError), Effect.asVoid),
        listMessages: ({ params }) =>
          deps.conversationService.listMessages(params.id).pipe(Effect.mapError(mapError)),
        postMessage: ({ params, payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const outcome = yield* deps.conversationCoordinator
              .sendMessage({
                conversationId: params.id,
                content: body.content ?? "",
                ...(body.senderType !== undefined && { senderType: body.senderType }),
              })
              .pipe(Effect.mapError(mapError));
            return { message: outcome.message, runId: outcome.run?.id ?? null };
          }),
        listSessions: ({ params }) =>
          deps.conversationSessionService
            .listSessions({ conversationId: params.id })
            .pipe(Effect.mapError(mapError)),
        createSession: ({ params, payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const sess = yield* deps.conversationSessionService
              .createSession({
                conversationId: params.id,
                runtimeSessionId: body.runtimeSessionId ?? "",
                ...(body.botId !== undefined && { botId: body.botId }),
              })
              .pipe(Effect.mapError(mapError));
            return sess;
          }),
        deleteSession: ({ params }) =>
          deps.conversationSessionService
            .deleteSession(params.id)
            .pipe(Effect.mapError(mapError), Effect.asVoid),
      });
    }),
  );

  const tasksLayer = HttpApiBuilder.group(
    Api,
    "tasks",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        listTasks: ({ query }) => {
          const q = query ?? {};
          return deps.taskService
            .listTasks({
              ...(q.requester && { requester: q.requester }),
              ...(q.assignee && { assignee: q.assignee }),
              ...(q.status && { status: q.status }),
              ...(q.limit !== undefined && { limit: q.limit }),
            })
            .pipe(Effect.mapError(mapError));
        },
        createTask: ({ payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const task = yield* deps.taskService
              .createTask({
                ...(body.requester !== undefined && { requester: body.requester }),
                assignee: body.assignee ?? "",
                description: body.description ?? "",
                ...(body.inputRefs !== undefined && { inputRefs: body.inputRefs }),
                ...(body.priority !== undefined && { priority: body.priority }),
                ...(body.deadline !== undefined && { deadline: body.deadline }),
                ...(body.depth !== undefined && { depth: body.depth }),
                ...(body.idempotencyKey !== undefined && { idempotencyKey: body.idempotencyKey }),
              })
              .pipe(Effect.mapError(mapError));
            if (body.assign) {
              const started = yield* deps.taskService
                .assignTask(String(task.id))
                .pipe(Effect.mapError(mapError));
              return started;
            }
            return task;
          }),
        getTask: ({ params }) =>
          Effect.gen(function* () {
            const task = yield* deps.taskService.getTask(params.id).pipe(Effect.mapError(mapError));
            if (!task) return yield* new HttpApiError.NotFound();
            return task;
          }),
        assignTask: ({ params }) =>
          deps.taskService.assignTask(params.id).pipe(Effect.mapError(mapError)),
        cancelTask: ({ params }) =>
          Effect.gen(function* () {
            const task = yield* deps.taskService
              .cancelTask(params.id)
              .pipe(Effect.mapError(mapError));
            if (!task) return yield* new HttpApiError.NotFound();
            return task;
          }),
        delegateTask: ({ payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            if (body.parallel && body.assignees) {
              const tasks = yield* deps.taskService
                .delegateParallel(
                  body.assignees.map((a) => ({
                    requester: body.requester ?? null,
                    assignee: a,
                    description: body.description ?? "",
                  })),
                )
                .pipe(Effect.mapError(mapError));
              return tasks;
            }
            const task = yield* deps.taskService
              .delegate({
                requester: body.requester ?? null,
                assignee: body.assignee ?? "",
                description: body.description ?? "",
              })
              .pipe(Effect.mapError(mapError));
            return task;
          }),
      });
    }),
  );

  const schedulesLayer = HttpApiBuilder.group(
    Api,
    "schedules",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        listSchedules: ({ query }) => {
          const q = query ?? {};
          return deps.scheduleService
            .listSchedules({
              ...(q.botId !== undefined && { botId: q.botId }),
              ...(q.createdBy !== undefined && { createdBy: q.createdBy }),
              ...(q.limit !== undefined && { limit: q.limit }),
            })
            .pipe(Effect.mapError(mapError));
        },
        createSchedule: ({ payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const trigger = validateScheduleTrigger(body.trigger);
            if (!trigger.valid) return yield* new HttpApiError.BadRequest();
            if (!body.botId) return yield* new HttpApiError.BadRequest();
            const schedule = yield* deps.scheduleService
              .createSchedule({
                botId: body.botId,
                prompt: body.prompt ?? "",
                trigger: trigger.value,
                ...(body.enabled !== undefined && { enabled: body.enabled }),
                ...(body.conversationId !== undefined && { conversationId: body.conversationId }),
                ...(body.createdBy !== undefined && { createdBy: body.createdBy }),
              })
              .pipe(Effect.mapError(mapError));
            return schedule;
          }),
        getSchedule: ({ params }) =>
          Effect.gen(function* () {
            const schedule = yield* deps.scheduleService
              .getSchedule(params.id)
              .pipe(Effect.mapError(mapError));
            if (!schedule) return yield* new HttpApiError.NotFound();
            return schedule;
          }),
        updateSchedule: ({ params, payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            let validatedTrigger: unknown;
            if (body.trigger !== undefined) {
              const trigger = validateScheduleTrigger(body.trigger);
              if (!trigger.valid) return yield* new HttpApiError.BadRequest();
              validatedTrigger = trigger.value;
            }
            const schedule = yield* deps.scheduleService
              .updateSchedule(params.id, {
                ...(body.prompt !== undefined && { prompt: body.prompt }),
                ...(validatedTrigger !== undefined && { trigger: validatedTrigger }),
                ...(body.enabled !== undefined && { enabled: body.enabled }),
              })
              .pipe(Effect.mapError(mapError));
            return schedule;
          }),
        deleteSchedule: ({ params }) =>
          deps.scheduleService
            .deleteSchedule(params.id)
            .pipe(Effect.mapError(mapError), Effect.asVoid),
        listOccurrences: ({ params, query }) => {
          const q = query ?? {};
          return deps.scheduleService
            .listHistory(params.id, q.limit)
            .pipe(Effect.mapError(mapError));
        },
      });
    }),
  );

  const activityLayer = HttpApiBuilder.group(
    Api,
    "activity",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        listActivity: ({ query }) => {
          const q = query ?? {};
          return deps.activityService
            .list({
              ...(q.type && { type: q.type }),
              ...(q.entityType && { entityType: q.entityType }),
              ...(q.entityId && { entityId: q.entityId }),
              ...(q.limit !== undefined && { limit: q.limit }),
            })
            .pipe(Effect.mapError(mapError));
        },
        postActivity: ({ payload }) =>
          Effect.gen(function* () {
            const body = payload ?? {};
            const ev = yield* deps.activityService
              .record({
                type: body.type ?? "event",
                entityType: body.entityType ?? "unknown",
                entityId: body.entityId ?? "",
                ...(body.actorId !== undefined && { actorId: body.actorId }),
                payload: body.payload,
              })
              .pipe(Effect.mapError(mapError));
            return ev;
          }),
      });
    }),
  );

  const controlLayer = HttpApiBuilder.group(
    Api,
    "control",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        controlStatus: () => Effect.succeed({ paused: deps.runService.isPaused() }),
        controlPause: () => {
          deps.runService.pause();
          return Effect.succeed({ paused: true });
        },
        controlResume: () => {
          deps.runService.resume();
          return Effect.succeed({ paused: false });
        },
        controlStop: () =>
          Effect.gen(function* () {
            yield* deps.runService.cancelAllRuns().pipe(Effect.mapError(mapError));
            deps.runService.pause();
            return { paused: true };
          }),
      });
    }),
  );

  const notesLayer = HttpApiBuilder.group(
    Api,
    "notes",
    Effect.fn(function* (handlers) {
      yield* Effect.void;
      return handlers.handleAll({
        searchNotes: ({ query }) =>
          Effect.gen(function* () {
            const q = query?.q ?? "";
            if (q.trim().length === 0) return yield* new HttpApiError.BadRequest();
            const botParam = query?.botId;
            if (!deps.indexer) return [];
            const hits = yield* deps.indexer
              .search(q, botParam ? asBotId(botParam) : undefined)
              .pipe(Effect.mapError(mapError));
            return hits;
          }),
      });
    }),
  );

  const allHandlerLayers = Layer.mergeAll(
    healthLayer,
    tokenLayer,
    modelsLayer,
    settingsLayer,
    botsLayer,
    runsLayer,
    conversationsLayer,
    tasksLayer,
    schedulesLayer,
    activityLayer,
    controlLayer,
    notesLayer,
  );

  const apiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(allHandlerLayers),
  );

  const docsRoute = HttpApiScalar.layer(Api, { path: "/docs" });

  return Layer.mergeAll(apiRoutes, docsRoute);
};

export { HttpRouter, HttpServer };
