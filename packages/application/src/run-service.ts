/* eslint-disable @typescript-eslint/no-this-alias */

import { Cause, Effect, Stream } from "effect";
import type {
  BotId,
  ConversationSession,
  Run,
  RunId,
  RunStatus,
  RunTrigger,
  ConversationId,
  ConversationSessionId,
  TaskId,
} from "@bebots/domain";
import { asRunId } from "@bebots/domain";
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
import { NotFoundError, RepositoryError, ServiceError, ValidationError, WorkspaceError } from "./errors.js";

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

function isDeps(value: unknown): value is RunServiceDeps {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const hasRunRepo = "runRepo" in v || "runRepository" in v;
  const hasBotRepo = "botRepo" in v || "botRepository" in v;
  const hasWorkspace = "workspace" in v;
  const hasRuntime = "runtime" in v;
  const hasClock = "clock" in v;
  const hasIds = "ids" in v || "idGenerator" in v;
  return hasRunRepo && hasBotRepo && hasWorkspace && hasRuntime && hasClock && hasIds;
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
  private readonly maxConcurrentRuns: number;
  private readonly maxConcurrentRunsPerBot: number;
  private paused: boolean = false;
  private readonly handles = new Map<string, RunHandle>();

  constructor(
    runRepoOrDeps: RunRepository | RunServiceDeps,
    botRepo?: BotRepository,
    workspace?: BotWorkspace,
    runtime?: AgentRuntime,
    clock?: Clock,
    ids?: IdGenerator,
    conversationSessions?: ConversationSessionOps,
    conversationMessages?: ConversationReplyRecorder,
    taskResults?: TaskResultRecorder,
    maxConcurrentRuns?: number,
    maxConcurrentRunsPerBot?: number,
  ) {
    if (isDeps(runRepoOrDeps)) {
      const v = runRepoOrDeps as unknown as Record<string, unknown>;
      this.runRepo = (v.runRepo ?? v.runRepository) as RunRepository;
      this.botRepo = (v.botRepo ?? v.botRepository) as BotRepository;
      this.workspace = v.workspace as BotWorkspace;
      this.runtime = v.runtime as AgentRuntime;
      this.clock = v.clock as Clock;
      this.ids = (v.ids ?? v.idGenerator) as IdGenerator;
      this.conversationSessions = v.conversationSessions as ConversationSessionOps | undefined;
      this.conversationMessages = v.conversationMessages as ConversationReplyRecorder | undefined;
      this.taskResults = v.taskResults as TaskResultRecorder | undefined;
      this.maxConcurrentRuns = (v.maxConcurrentRuns as number | undefined) ?? 10;
      this.maxConcurrentRunsPerBot = (v.maxConcurrentRunsPerBot as number | undefined) ?? 3;
    } else {
      this.runRepo = runRepoOrDeps;
      this.botRepo = botRepo as BotRepository;
      this.workspace = workspace as BotWorkspace;
      this.runtime = runtime as AgentRuntime;
      this.clock = clock as Clock;
      this.ids = ids as IdGenerator;
      this.conversationSessions = conversationSessions;
      this.conversationMessages = conversationMessages;
      this.taskResults = taskResults;
      this.maxConcurrentRuns = maxConcurrentRuns ?? 10;
      this.maxConcurrentRunsPerBot = maxConcurrentRunsPerBot ?? 3;
    }
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
      const runningForBot = yield* self.runRepo.findAll({ botId: input.botId, status: "running" });
      if (runningForBot.length >= self.maxConcurrentRunsPerBot) {
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
          storedSession = yield* sessions.findResumableSession(String(input.conversationId));
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

      const request: RunRequest = {
        botId: input.botId,
        workingDirectory: home,
        prompt,
        sessionId: resumeSessionId,
        timeoutMs,
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
        // Event-stream failures must not abort result capture.
        yield* Stream.runForEach(self.runtime.streamEvents(handle), (event: RuntimeEvent) =>
          self.runRepo.appendEvent(runId, event),
        ).pipe(Effect.ignore);

        const current = yield* self.runRepo.findById(runId);
        if (!current || current.status === "cancelled") return;

        const result = yield* self.runtime.getResult(handle);
        const terminalStatus: RunStatus = result.exitCode === 0 ? "succeeded" : "failed";
        const finalRun: Run = {
          ...startedRun,
          status: terminalStatus,
          ...(result.sessionId !== undefined && { sessionId: result.sessionId }),
          endedAt: self.clock.now(),
          exitCode: result.exitCode,
          summary: result.summary,
          updatedAt: self.clock.now(),
        };
        yield* self.runRepo.update(finalRun);

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
      const handle = self.handles.get(String(id));
      if (handle) {
        yield* self.runtime.cancelRun(handle);
      }
      self.handles.delete(String(id));
      const updated: Run = {
        ...run,
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
      return updated;
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

  cancelAllRuns(): Effect.Effect<void, RuntimeError> {
    const self = this;
    return Effect.gen(function* () {
      const running = yield* self.runRepo.findAll({ status: "running" }).pipe(
        Effect.catchCause(() => Effect.succeed([] as readonly Run[])),
      );
      for (const run of running) {
        yield* self.cancelRun(run.id).pipe(Effect.ignore);
      }
      self.handles.clear();
    });
  }

  awaitRun(id: RunId, timeoutMs = 300_000): Effect.Effect<Run | null, RepositoryError> {
    const self = this;
    return Effect.gen(function* () {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const run = yield* self.runRepo.findById(id);
        if (!run) return null;
        if (run.status !== "queued" && run.status !== "running") return run;
        yield* Effect.sleep("500 millis");
      }
      return yield* self.runRepo.findById(id);
    });
  }
}

export class RunSupervisor extends RunService {}
