/* eslint-disable @typescript-eslint/no-this-alias */

import { Cause, Effect, Stream } from "effect";
import type { BotId, Run, RunId, RunStatus, RunTrigger } from "@bebots/domain";
import { asRunId } from "@bebots/domain";
import type { AgentRuntime, RunHandle, RunRequest, RuntimeError, RuntimeEvent } from "./runtime.js";
import type { BotRepository, BotWorkspace, Clock, IdGenerator, RunRepository } from "./repositories.js";
import { NotFoundError, RepositoryError, ValidationError, WorkspaceError } from "./errors.js";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
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
}

export interface StartRunInput {
  readonly botId: BotId;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly triggerType?: RunTrigger;
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
  private readonly handles = new Map<string, RunHandle>();

  constructor(
    runRepoOrDeps: RunRepository | RunServiceDeps,
    botRepo?: BotRepository,
    workspace?: BotWorkspace,
    runtime?: AgentRuntime,
    clock?: Clock,
    ids?: IdGenerator,
  ) {
    if (isDeps(runRepoOrDeps)) {
      const v = runRepoOrDeps as unknown as Record<string, unknown>;
      this.runRepo = (v.runRepo ?? v.runRepository) as RunRepository;
      this.botRepo = (v.botRepo ?? v.botRepository) as BotRepository;
      this.workspace = v.workspace as BotWorkspace;
      this.runtime = v.runtime as AgentRuntime;
      this.clock = v.clock as Clock;
      this.ids = (v.ids ?? v.idGenerator) as IdGenerator;
    } else {
      this.runRepo = runRepoOrDeps;
      this.botRepo = botRepo as BotRepository;
      this.workspace = workspace as BotWorkspace;
      this.runtime = runtime as AgentRuntime;
      this.clock = clock as Clock;
      this.ids = ids as IdGenerator;
    }
  }

  startRun(
    input: StartRunInput,
  ): Effect.Effect<Run, ValidationError | NotFoundError | RepositoryError | WorkspaceError | RuntimeError> {
    const self = this;
    return Effect.gen(function* () {
      const bot = yield* self.botRepo.findById(input.botId);
      if (!bot) {
        return yield* Effect.fail(new NotFoundError("Bot", input.botId));
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
      const now = self.clock.now();
      const run: Run = {
        id: runId,
        botId: input.botId,
        triggerType: input.triggerType ?? "manual",
        prompt,
        status: "queued",
        sessionId: input.sessionId,
        timeoutMs,
        createdAt: now,
        updatedAt: now,
      } as Run;
      yield* self.runRepo.create(run);

      const request: RunRequest = {
        botId: input.botId,
        workingDirectory: home,
        prompt,
        sessionId: input.sessionId,
        timeoutMs,
      } as RunRequest;

      const handle = yield* self.runtime.startRun(request);
      const startedRun: Run = {
        ...run,
        sessionId: (handle.sessionId ?? run.sessionId) as string,
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
        yield* Stream.runForEach(
          self.runtime.streamEvents(handle),
          (event: RuntimeEvent) => self.runRepo.appendEvent(runId, event),
        ).pipe(Effect.ignore);

        const current = yield* self.runRepo.findById(runId);
        if (!current || current.status === "cancelled") return;

        const result = yield* self.runtime.getResult(handle);
        const terminalStatus: RunStatus =
          result.exitCode === 0 ? "succeeded" : "failed";
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
        Effect.catchCause((cause) => Effect.logError("Run finalization failed", runId, describeError(Cause.squash(cause)))),
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
      const updated: Run = {
        ...run,
        status: "cancelled",
        endedAt: self.clock.now(),
        updatedAt: self.clock.now(),
      };
      yield* self.runRepo.update(updated) as Effect.Effect<Run, RepositoryError | RuntimeError>;
      return updated;
    });
  }

  getRunEvents(id: RunId) {
    return this.runRepo.listEvents(id);
  }

  awaitRun(
    id: RunId,
    timeoutMs = 300_000,
  ): Effect.Effect<Run | null, RepositoryError> {
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
