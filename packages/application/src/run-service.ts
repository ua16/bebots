/* eslint-disable @typescript-eslint/no-this-alias */

import { Cause, Effect, Option, Stream } from "effect";
import type {
  BotId,
  ConversationSession,
  Form,
  FormAnswers,
  FormId,
  Run,
  RunId,
  RunStatus,
  RunTrigger,
  ConversationId,
  ConversationSessionId,
  TaskId,
} from "@bebots/domain";
import { asRunId, isDesktopRenderableForm } from "@bebots/domain";
import type { AgentRuntime, RunHandle, RunRequest, RuntimeError, RuntimeEvent } from "./runtime.js";
import type { ConversationSessionOps } from "./conversation-service.js";
import type { ConversationReplyRecorder } from "./conversation-run-coordinator.js";
import type {
  BotRepository,
  BotWorkspace,
  Clock,
  IdGenerator,
  RunRepository,
} from "./repositories.js";
import {
  NotFoundError,
  RepositoryError,
  ServiceError,
  ValidationError,
  WorkspaceError,
} from "./errors.js";
import type { AppSettingsService } from "./app-settings.js";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

/** How long a run may wait for human form input before auto-dismiss. */
export const INPUT_DEADLINE_MS = 12 * 60 * 60 * 1000;

export interface RunServiceDeps {
  readonly runRepo: RunRepository;
  readonly botRepo: BotRepository;
  readonly workspace: BotWorkspace;
  readonly runtime: AgentRuntime;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Session-store operations; enables conversation-resume behavior (PLAN §6.4). */
  readonly conversationSessions?: ConversationSessionOps;
  /** Reply recording; conversation runs post their summary into the thread. */
  readonly conversationMessages?: ConversationReplyRecorder;
  /** Task result recording; runs linked to a task update its status. */
  readonly taskResults?: TaskResultRecorder;
  /** Schedule occurrence recording; runs triggered by a schedule update it. */
  readonly scheduleResults?: ScheduleResultRecorder;
  /** App settings; supplies the default model when a bot has no override. */
  readonly settings?: AppSettingsService;
  /** Global concurrency limits. */
  readonly maxConcurrentRuns?: number;
  readonly maxConcurrentRunsPerBot?: number;
}

export interface TaskResultRecorder {
  readonly recordTaskResult: (
    taskId: string,
    runId: string,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    summary?: string,
  ) => Effect.Effect<void, unknown>;
}

/** Receiver of terminal results for schedule-triggered runs (PLAN §9). */
export interface ScheduleResultRecorder {
  readonly recordRunResult: (
    runId: string,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    summary?: string,
  ) => Effect.Effect<void, unknown>;
}

export interface StartRunInput {
  readonly botId: BotId;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly conversationId?: ConversationId;
  readonly conversationSessionId?: ConversationSessionId;
  readonly triggerType?: RunTrigger;
  readonly taskId?: TaskId;
  readonly newSession?: boolean;
}

export class RunService {
  private readonly runRepo: RunRepository;
  private readonly botRepo: BotRepository;
  private readonly workspace: BotWorkspace;
  private readonly runtime: AgentRuntime;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly conversationSessions: ConversationSessionOps | undefined;
  private readonly conversationMessages: ConversationReplyRecorder | undefined;
  private taskResults: TaskResultRecorder | undefined;
  private scheduleResults: ScheduleResultRecorder | undefined;
  private readonly settings: AppSettingsService | undefined;
  private readonly maxConcurrentRuns: number;
  private readonly maxConcurrentRunsPerBot: number;
  private paused: boolean = false;
  private readonly handles = new Map<string, RunHandle>();
  private readonly inputDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: RunServiceDeps) {
    this.runRepo = deps.runRepo;
    this.botRepo = deps.botRepo;
    this.workspace = deps.workspace;
    this.runtime = deps.runtime;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.conversationSessions = deps.conversationSessions;
    this.conversationMessages = deps.conversationMessages;
    this.taskResults = deps.taskResults;
    this.scheduleResults = deps.scheduleResults;
    this.settings = deps.settings;
    this.maxConcurrentRuns = deps.maxConcurrentRuns ?? 10;
    this.maxConcurrentRunsPerBot = deps.maxConcurrentRunsPerBot ?? 3;
  }

  startRun(
    input: StartRunInput,
  ): Effect.Effect<
    Run,
    ValidationError | NotFoundError | RepositoryError | WorkspaceError | RuntimeError | ServiceError
  > {
    const self = this;
    return Effect.gen(function* () {
      if (self.paused) {
        return yield* Effect.fail(new ServiceError("Application is paused; new runs are disabled"));
      }
      const bot = yield* self.botRepo.findById(input.botId);
      if (!bot) {
        return yield* Effect.fail(new NotFoundError("Bot", input.botId));
      }
      // Concurrency controls.
      const running = [...self.handles.keys()];
      if (running.length >= self.maxConcurrentRuns) {
        return yield* Effect.fail(new ServiceError("Global run concurrency limit reached"));
      }
      const botRuns = yield* self.runRepo.findAll({ botId: input.botId });
      const activeForBot = botRuns.filter(
        (r) =>
          String(r.botId) === String(input.botId) &&
          (r.status === "running" || r.status === "awaiting_input"),
      );
      if (activeForBot.length >= self.maxConcurrentRunsPerBot) {
        return yield* Effect.fail(new ServiceError("Per-bot run concurrency limit reached"));
      }
      const prompt = (input.prompt ?? "").trim();
      if (prompt.length === 0) {
        return yield* Effect.fail(new ValidationError("prompt", "Prompt cannot be empty"));
      }
      const timeoutMs = input.timeoutMs ?? 300_000;
      const home = self.workspace.homePath(input.botId);
      let runId: RunId;
      try {
        runId = asRunId(self.ids.generate());
      } catch {
        return yield* Effect.fail(new ValidationError("id", "Invalid run id"));
      }

      // Resolve the stored session to resume (PLAN §6.4): an explicit session
      // wins; otherwise, for conversation runs, resume the most recent active
      // ConversationSession by default.
      let storedSession: ConversationSession | null = null;
      let resumeSessionId: string | undefined = input.sessionId;
      const sessions = self.conversationSessions;
      if (!input.newSession && sessions && input.conversationId) {
        if (input.conversationSessionId) {
          storedSession = yield* sessions.getSession(String(input.conversationSessionId));
          if (!storedSession) {
            return yield* Effect.fail(
              new NotFoundError("ConversationSession", String(input.conversationSessionId)),
            );
          }
        } else {
          // Per-bot scoping: only resume a session the run's own bot recorded,
          // never another bot's session in the same thread.
          storedSession = yield* sessions.findResumableSession(
            String(input.conversationId),
            String(input.botId),
          );
        }
        if (storedSession) {
          resumeSessionId = storedSession.runtimeSessionId;
        }
      }

      let conversationSessionId: ConversationSessionId | undefined =
        storedSession?.id ?? input.conversationSessionId;
      const now = self.clock.now();
      const run: Run = {
        id: runId,
        botId: input.botId,
        triggerType: input.triggerType ?? "manual",
        prompt,
        status: "queued",
        sessionId: resumeSessionId,
        conversationId: input.conversationId,
        conversationSessionId,
        taskId: input.taskId,
        timeoutMs,
        createdAt: now,
        updatedAt: now,
      } as Run;
      yield* self.runRepo.create(run);

      // Model resolution: the bot's own override wins, then the app-wide
      // default model. A settings failure must not block the run — the
      // runtime then falls back to OpenCode's own default.
      let model = bot.model ?? null;
      if (model === null && self.settings) {
        const defaultModel = yield* Effect.option(self.settings.getDefaultModel());
        if (Option.isSome(defaultModel)) {
          model = defaultModel.value;
        }
      }

      const request: RunRequest = {
        botId: input.botId,
        workingDirectory: home,
        prompt,
        sessionId: resumeSessionId,
        timeoutMs,
        ...(model !== null && { model }),
      } as RunRequest;

      const handle = yield* self.runtime.startRun(request);
      const usedSessionId = handle.sessionId ?? resumeSessionId;

      // Capture/rotate the ConversationSession record. This must not block
      // the run when bookkeeping fails (e.g. the record was deleted in a
      // race): failures are logged, never silently swallowed.
      const bookkeeping = Effect.gen(function* () {
        if (input.newSession) return;
        if (!sessions || !input.conversationId || usedSessionId === undefined) return;
        if (storedSession) {
          if (storedSession.runtimeSessionId !== usedSessionId) {
            storedSession = yield* sessions.replaceRuntimeSession(
              String(storedSession.id),
              usedSessionId,
            );
          } else {
            storedSession = yield* sessions.touchSession(String(storedSession.id));
          }
        } else {
          storedSession = yield* sessions.createSession({
            conversationId: String(input.conversationId),
            runtimeSessionId: usedSessionId,
            // Per-bot scoping: the session belongs to the bot that started it.
            botId: String(input.botId),
          });
        }
        conversationSessionId = storedSession?.id ?? conversationSessionId;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            "Conversation session bookkeeping failed",
            runId,
            describeError(Cause.squash(cause)),
          ),
        ),
      );
      yield* bookkeeping;

      const startedRun: Run = {
        ...run,
        ...(usedSessionId !== undefined && { sessionId: usedSessionId }),
        ...(conversationSessionId !== undefined && { conversationSessionId }),
        status: "running",
        startedAt: self.clock.now(),
        updatedAt: self.clock.now(),
      };
      yield* self.runRepo.update(startedRun);
      self.handles.set(String(runId), handle);

      // Finalize the run in a detached Effect fiber (survives startRun's
      // parent fiber): stream events into the repository, then persist the
      // terminal status. Failures are recorded on the run or logged, never
      // silently swallowed.
      const finalize: Effect.Effect<void> = Effect.gen(function* () {
        yield* Stream.runForEach(self.runtime.streamEvents(handle), (event: RuntimeEvent) =>
          Effect.gen(function* () {
            yield* self.runRepo.appendEvent(runId, event);
            if (event._tag === "user_input_requested") {
              yield* self.enterAwaitingInput(runId, event.formId);
            } else if (event._tag === "user_input_resolved" && event.outcome === "answered") {
              yield* self.clearAwaitingInput(runId, "running");
            }
          }),
        ).pipe(Effect.ignore);

        const current = yield* self.runRepo.findById(runId);
        if (!current || current.status === "cancelled") return;

        const result = yield* self.runtime.getResult(handle);
        const terminalStatus: RunStatus =
          result.exitCode === 0
            ? "succeeded"
            : result.exitCode === 130
              ? "cancelled"
              : result.exitCode === 124
                ? "timed_out"
                : "failed";
        const latest = yield* self.runRepo.findById(runId);
        if (!latest || latest.status === "cancelled") return;
        const {
          pendingFormId: _pf,
          inputDeadlineAt: _dl,
          ...latestRest
        } = latest;
        const finalRun: Run = {
          ...latestRest,
          status: terminalStatus,
          ...(result.sessionId !== undefined && { sessionId: result.sessionId }),
          endedAt: self.clock.now(),
          exitCode: result.exitCode,
          summary: result.summary,
          updatedAt: self.clock.now(),
        };
        yield* self.runRepo.update(finalRun);
        self.clearInputDeadline(String(runId));

        // Task result link: if this run was started for a task, update the
        // task's status and result reference.
        const taskResults = self.taskResults;
        if (taskResults && finalRun.taskId !== undefined) {
          yield* taskResults
            .recordTaskResult(
              String(finalRun.taskId),
              String(finalRun.id),
              terminalStatus === "succeeded" ? "succeeded" : "failed",
              finalRun.summary,
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  "Recording task result failed",
                  runId,
                  describeError(Cause.squash(cause)),
                ),
              ),
            );
        }

        // Schedule occurrence link: scheduled runs resolve their persisted
        // occurrence so the UI/API can show schedule history (PLAN §9).
        const scheduleResults = self.scheduleResults;
        if (scheduleResults && finalRun.triggerType === "schedule") {
          yield* scheduleResults
            .recordRunResult(
              String(finalRun.id),
              terminalStatus === "succeeded" ? "succeeded" : "failed",
              finalRun.summary,
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  "Recording schedule result failed",
                  runId,
                  describeError(Cause.squash(cause)),
                ),
              ),
            );
        }

        // PLAN §12 M3: a succeeded conversation run posts its answer into the
        // thread as a bot reply — whoever started it. Recording must not be
        // able to take finalization down; failures are logged.
        const replies = self.conversationMessages;
        if (
          replies &&
          finalRun.conversationId !== undefined &&
          String(finalRun.summary ?? "").trim().length > 0
        ) {
          yield* replies
            .recordBotReply(
              String(finalRun.conversationId),
              String(finalRun.botId),
              String(finalRun.summary),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  "Recording bot reply failed",
                  runId,
                  describeError(Cause.squash(cause)),
                ),
              ),
            );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const current = yield* self.runRepo.findById(runId);
            if (current?.status === "cancelled") return;
            const now = self.clock.now();
            yield* self.runRepo.update({
              ...startedRun,
              status: "failed",
              endedAt: now,
              error: describeError(Cause.squash(cause)),
              updatedAt: now,
            });
          }),
        ),
        // Failures of the fallback path itself (e.g. the persisted run is
        // unreachable) can only be surfaced through Effect's log channel; they
        // must not disappear silently.
        Effect.catchCause((cause) =>
          Effect.logError("Run finalization failed", runId, describeError(Cause.squash(cause))),
        ),
        Effect.ensuring(Effect.sync(() => self.handles.delete(String(runId)))),
      );
      yield* Effect.forkDetach(finalize);

      return startedRun;
    });
  }

  getRun(id: RunId): Effect.Effect<Run | null, RepositoryError> {
    return this.runRepo.findById(id);
  }

  listRuns(options?: {
    readonly botId?: BotId;
    readonly status?: RunStatus;
    readonly limit?: number;
  }): Effect.Effect<readonly Run[], RepositoryError> {
    return this.runRepo.findAll(options);
  }

  cancelRun(id: RunId): Effect.Effect<Run | null, RepositoryError | RuntimeError> {
    const self = this;
    return Effect.gen(function* () {
      const run = yield* self.runRepo.findById(id);
      if (!run) return null;
      self.clearInputDeadline(String(id));
      const handle = self.handles.get(String(id));
      if (handle) {
        yield* self.runtime.cancelRun(handle);
      }
      self.handles.delete(String(id));
      const { pendingFormId: _pf, inputDeadlineAt: _dl, ...rest } = run;
      const updated: Run = {
        ...rest,
        status: "cancelled",
        endedAt: self.clock.now(),
        updatedAt: self.clock.now(),
      };
      yield* self.runRepo.update(updated) as Effect.Effect<Run, RepositoryError | RuntimeError>;
      const taskResults = self.taskResults;
      if (taskResults && run.taskId) {
        yield* taskResults
          .recordTaskResult(String(run.taskId), String(run.id), "cancelled")
          .pipe(Effect.ignore);
      }
      const scheduleResults = self.scheduleResults;
      if (scheduleResults && run.triggerType === "schedule") {
        yield* scheduleResults.recordRunResult(String(run.id), "cancelled").pipe(Effect.ignore);
      }
      return updated;
    });
  }

  getInput(id: RunId): Effect.Effect<Form, NotFoundError | ServiceError | RuntimeError | RepositoryError> {
    const self = this;
    return Effect.gen(function* () {
      const run = yield* self.runRepo.findById(id);
      if (!run || run.status !== "awaiting_input" || run.pendingFormId === undefined) {
        return yield* Effect.fail(new NotFoundError("RunInput", String(id)));
      }
      const handle = self.handles.get(String(id));
      if (!handle || !self.runtime.getForm) {
        return yield* Effect.fail(new ServiceError("Runtime cannot hydrate forms"));
      }
      return yield* self.runtime.getForm(handle, run.pendingFormId);
    });
  }

  replyToInput(
    id: RunId,
    answers: FormAnswers,
  ): Effect.Effect<Run, NotFoundError | ServiceError | ValidationError | RuntimeError | RepositoryError> {
    const self = this;
    return Effect.gen(function* () {
      const run = yield* self.runRepo.findById(id);
      if (!run || run.status !== "awaiting_input" || run.pendingFormId === undefined) {
        return yield* Effect.fail(new NotFoundError("RunInput", String(id)));
      }
      const handle = self.handles.get(String(id));
      if (!handle || !self.runtime.replyToForm) {
        return yield* Effect.fail(new ServiceError("Runtime cannot reply to forms"));
      }
      yield* self.runtime.replyToForm(handle, run.pendingFormId, answers);
      self.clearInputDeadline(String(id));
      const { pendingFormId: _pf, inputDeadlineAt: _dl, ...rest } = run;
      const updated: Run = {
        ...rest,
        status: "running",
        updatedAt: self.clock.now(),
      };
      yield* self.runRepo.update(updated);
      return updated;
    });
  }

  dismissInput(
    id: RunId,
  ): Effect.Effect<Run, NotFoundError | ServiceError | RuntimeError | RepositoryError> {
    const self = this;
    return Effect.gen(function* () {
      const run = yield* self.runRepo.findById(id);
      if (!run || run.status !== "awaiting_input" || run.pendingFormId === undefined) {
        return yield* Effect.fail(new NotFoundError("RunInput", String(id)));
      }
      const handle = self.handles.get(String(id));
      if (!handle || !self.runtime.dismissForm) {
        return yield* Effect.fail(new ServiceError("Runtime cannot dismiss forms"));
      }
      yield* self.runtime.dismissForm(handle, run.pendingFormId);
      self.clearInputDeadline(String(id));
      const { pendingFormId: _pf, inputDeadlineAt: _dl, ...rest } = run;
      const updated: Run = {
        ...rest,
        status: "cancelled",
        endedAt: self.clock.now(),
        updatedAt: self.clock.now(),
        summary: "dismissed",
      };
      yield* self.runRepo.update(updated);
      self.handles.delete(String(id));
      return updated;
    });
  }

  /**
   * Desktop v1 cannot show every form field kind. Decline unsupported forms
   * the same way as an explicit dismiss (stops the run).
   */
  declineUnsupportedInput(
    id: RunId,
    form: Form,
  ): Effect.Effect<Run | null, NotFoundError | ServiceError | RuntimeError | RepositoryError> {
    if (isDesktopRenderableForm(form)) return Effect.succeed(null);
    return this.dismissInput(id);
  }

  private enterAwaitingInput(
    runId: RunId,
    formId: FormId,
  ): Effect.Effect<void, RepositoryError | NotFoundError> {
    const self = this;
    return Effect.gen(function* () {
      const run = yield* self.runRepo.findById(runId);
      if (!run || run.status === "cancelled" || run.status === "succeeded" || run.status === "failed") {
        return;
      }
      const deadline = self.clock.now() + INPUT_DEADLINE_MS;
      const updated: Run = {
        ...run,
        status: "awaiting_input",
        pendingFormId: formId,
        inputDeadlineAt: deadline,
        updatedAt: self.clock.now(),
      };
      yield* self.runRepo.update(updated);
      self.armInputDeadline(String(runId), deadline);
    });
  }

  private clearAwaitingInput(
    runId: RunId,
    next: "running",
  ): Effect.Effect<void, RepositoryError | NotFoundError> {
    const self = this;
    return Effect.gen(function* () {
      const run = yield* self.runRepo.findById(runId);
      if (!run || run.status !== "awaiting_input") return;
      self.clearInputDeadline(String(runId));
      const { pendingFormId: _pf, inputDeadlineAt: _dl, ...rest } = run;
      yield* self.runRepo.update({
        ...rest,
        status: next,
        updatedAt: self.clock.now(),
      });
    });
  }

  private armInputDeadline(runId: string, deadlineAt: number): void {
    this.clearInputDeadline(runId);
    const delay = Math.max(0, deadlineAt - this.clock.now());
    const timer = setTimeout(() => {
      this.inputDeadlineTimers.delete(runId);
      void Effect.runPromise(
        this.expireInput(asRunId(runId)).pipe(Effect.ignore),
      );
    }, delay);
    this.inputDeadlineTimers.set(runId, timer);
  }

  private clearInputDeadline(runId: string): void {
    const timer = this.inputDeadlineTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.inputDeadlineTimers.delete(runId);
    }
  }

  private expireInput(
    id: RunId,
  ): Effect.Effect<void, RepositoryError | RuntimeError | NotFoundError | ServiceError> {
    const self = this;
    return Effect.gen(function* () {
      const run = yield* self.runRepo.findById(id);
      if (!run || run.status !== "awaiting_input" || run.pendingFormId === undefined) return;
      const handle = self.handles.get(String(id));
      if (handle && self.runtime.dismissForm) {
        yield* self.runtime.dismissForm(handle, run.pendingFormId).pipe(Effect.ignore);
      }
      yield* self.runRepo.appendEvent(id, {
        _tag: "user_input_resolved",
        formId: run.pendingFormId,
        outcome: "expired",
        at: new Date(),
      });
      const { pendingFormId: _pf, inputDeadlineAt: _dl, ...rest } = run;
      yield* self.runRepo.update({
        ...rest,
        status: "cancelled",
        endedAt: self.clock.now(),
        summary: "input expired",
        updatedAt: self.clock.now(),
      });
      self.handles.delete(String(id));
    });
  }

  getRunEvents(id: RunId) {
    return this.runRepo.listEvents(id);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setTaskResults(tr: TaskResultRecorder | undefined): void {
    this.taskResults = tr;
  }

  setScheduleResults(sr: ScheduleResultRecorder | undefined): void {
    this.scheduleResults = sr;
  }

  cancelAllRuns(): Effect.Effect<void, RuntimeError> {
    const self = this;
    return Effect.gen(function* () {
      for (const status of ["running", "awaiting_input"] as const) {
        const runs = yield* self.runRepo
          .findAll({ status })
          .pipe(Effect.catchCause(() => Effect.succeed([] as readonly Run[])));
        for (const run of runs) {
          yield* self.cancelRun(run.id).pipe(Effect.ignore);
        }
      }
      self.handles.clear();
    });
  }

  /**
   * Cancel every queued/running/awaiting_input run of one bot (bot deletion prep).
   */
  cancelRunsForBot(botId: BotId): Effect.Effect<void, RepositoryError> {
    const self = this;
    return Effect.gen(function* () {
      for (const status of ["queued", "running", "awaiting_input"] as const) {
        const runs = yield* self.runRepo
          .findAll({ botId, status })
          .pipe(Effect.catchCause(() => Effect.succeed([] as readonly Run[])));
        for (const run of runs) {
          yield* self.cancelRun(run.id).pipe(Effect.ignore);
        }
      }
    });
  }

  /**
   * Cancel every active run bound to a conversation (any bot) —
   * conversation deletion prep. Same failure policy as `cancelRunsForBot`.
   */
  cancelRunsForConversation(conversationId: ConversationId): Effect.Effect<void, RepositoryError> {
    const self = this;
    return Effect.gen(function* () {
      for (const status of ["queued", "running", "awaiting_input"] as const) {
        const runs = yield* self.runRepo
          .findAll({ conversationId, status })
          .pipe(Effect.catchCause(() => Effect.succeed([] as readonly Run[])));
        for (const run of runs) {
          yield* self.cancelRun(run.id).pipe(Effect.ignore);
        }
      }
    });
  }

  /**
   * Delete every run row (and its events) bound to a conversation — the
   * thread's history dies with the thread. Call only after
   * `cancelRunsForConversation`, so nothing can finalize into deleted rows.
   */
  deleteRunsForConversation(
    conversationId: ConversationId,
  ): Effect.Effect<number, RepositoryError> {
    return this.runRepo.deleteByConversation(conversationId);
  }

  awaitRun(id: RunId, timeoutMs = 300_000): Effect.Effect<Run | null, RepositoryError> {
    const self = this;
    return Effect.gen(function* () {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const run = yield* self.runRepo.findById(id);
        if (!run) return null;
        // awaiting_input is returned so clients can show the form card.
        if (run.status !== "queued" && run.status !== "running") return run;
        yield* Effect.sleep("500 millis");
      }
      return yield* self.runRepo.findById(id);
    });
  }
}
