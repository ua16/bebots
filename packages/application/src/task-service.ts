import { Cause, Effect } from "effect";
import { asTaskId } from "@bebots/domain";
import type { BotId, RunId, Task, TaskId, TaskStatus } from "@bebots/domain";
import { canTransitionTask } from "@bebots/domain";
import type {
  TaskRepository,
  BotRepository,
  BotWorkspace,
  Clock,
  IdGenerator,
} from "./repositories.js";
import type { RunService, TaskResultRecorder } from "./run-service.js";
import { NotFoundError, RepositoryError, ServiceError, ValidationError } from "./errors.js";

export const MAX_TASK_DEPTH = 5;
export const MAX_PARALLEL_DELEGATIONS = 10;

export interface CreateTaskInput {
  readonly requester?: string | null;
  readonly assignee: string;
  readonly description: string;
  readonly inputRefs?: readonly string[];
  readonly priority?: number;
  readonly deadline?: number;
  readonly depth?: number;
  readonly idempotencyKey?: string;
}

export interface TaskServiceDeps {
  readonly taskRepo: TaskRepository;
  readonly botRepo: BotRepository;
  readonly workspace?: BotWorkspace;
  readonly runService: RunService;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly maxDepth?: number;
  readonly maxParallel?: number;
}

export class TaskService implements TaskResultRecorder {
  private readonly taskRepo: TaskRepository;
  private readonly botRepo: BotRepository;
  private readonly runService: RunService;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly maxDepth: number;
  private readonly maxParallel: number;

  constructor(
    depsOrTaskRepo: TaskServiceDeps | TaskRepository,
    botRepo?: BotRepository,
    runService?: RunService,
    clock?: Clock,
    ids?: IdGenerator,
    maxDepth?: number,
    maxParallel?: number,
  ) {
    let deps: TaskServiceDeps;
    if (
      typeof depsOrTaskRepo === "object" &&
      depsOrTaskRepo !== null &&
      "taskRepo" in (depsOrTaskRepo as unknown as Record<string, unknown>)
    ) {
      deps = depsOrTaskRepo as TaskServiceDeps;
    } else {
      deps = {
        taskRepo: depsOrTaskRepo as TaskRepository,
        botRepo: botRepo as BotRepository,
        runService: runService as RunService,
        ...(clock !== undefined && { clock }),
        ...(ids !== undefined && { ids }),
        ...(maxDepth !== undefined && { maxDepth }),
        ...(maxParallel !== undefined && { maxParallel }),
      };
    }
    this.taskRepo = deps.taskRepo;
    this.botRepo = deps.botRepo;
    this.runService = deps.runService;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.ids = deps.ids ?? { generate: () => crypto.randomUUID() };
    this.maxDepth = deps.maxDepth ?? maxDepth ?? MAX_TASK_DEPTH;
    this.maxParallel = deps.maxParallel ?? maxParallel ?? MAX_PARALLEL_DELEGATIONS;
  }

  recordTaskResult(
    taskId: string,
    runId: string,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    summary?: string,
  ): Effect.Effect<void, unknown> {
    const taskRepo = this.taskRepo;
    const clock = this.clock;
    return Effect.gen(function* () {
      const existing = yield* taskRepo.findById(asTaskId(taskId));
      if (!existing) return;
      const nextStatus: TaskStatus =
        status === "succeeded"
          ? "succeeded"
          : status === "cancelled"
            ? "cancelled"
            : "failed";
      if (!canTransitionTask(existing.status, nextStatus)) return;
      const updated: Task = {
        ...existing,
        status: nextStatus,
        resultRunId: runId as unknown as RunId,
        ...(summary !== undefined && { resultSummary: summary }),
        updatedAt: clock.now(),
      };
      yield* taskRepo.update(updated);
    }).pipe(Effect.ignore);
  }

  createTask(
    input: CreateTaskInput,
  ): Effect.Effect<Task, ValidationError | NotFoundError | RepositoryError | ServiceError> {
    const taskRepo = this.taskRepo;
    const botRepo = this.botRepo;
    const clock = this.clock;
    const ids = this.ids;
    const maxDepth = this.maxDepth;
    return Effect.gen(function* () {
      const description = (input.description ?? "").trim();
      if (description.length === 0) {
        return yield* Effect.fail(new ValidationError("description", "Task description cannot be empty"));
      }
      const assignee = (input.assignee ?? "").trim();
      if (assignee.length === 0) {
        return yield* Effect.fail(new ValidationError("assignee", "Assignee is required"));
      }
      const bot = yield* botRepo.findById(assignee as BotId);
      if (!bot || bot.status !== "active") {
        return yield* Effect.fail(new NotFoundError("Bot", assignee));
      }
      const depth = input.depth ?? 0;
      if (depth > maxDepth) {
        return yield* Effect.fail(new ServiceError("Delegation depth limit exceeded"));
      }
      // Idempotency.
      if (input.idempotencyKey) {
        const existing = yield* taskRepo.findByIdempotencyKey(input.idempotencyKey);
        if (existing) return existing;
      }
      let id: TaskId;
      try {
        id = asTaskId(ids.generate());
      } catch {
        return yield* Effect.fail(new ValidationError("id", "Invalid task id"));
      }
      const now = clock.now();
      const task: Task = {
        id,
        requester: input.requester ?? null,
        assignee,
        description,
        inputRefs: input.inputRefs ?? [],
        priority: input.priority ?? 0,
        status: "queued",
        ...(input.deadline !== undefined && { deadline: input.deadline }),
        depth,
        ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        createdAt: now,
        updatedAt: now,
      };
      return yield* taskRepo.create(task);
    }) as Effect.Effect<Task, ValidationError | NotFoundError | RepositoryError | ServiceError>;
  }

  getTask(id: string): Effect.Effect<Task | null, RepositoryError> {
    return this.taskRepo.findById(asTaskId(id));
  }

  listTasks(options?: {
    readonly requester?: string;
    readonly assignee?: string;
    readonly status?: TaskStatus;
    readonly limit?: number;
  }): Effect.Effect<readonly Task[], RepositoryError> {
    return this.taskRepo.findAll(options);
  }

  /** Assign a queued task to its assignee and start a run. */
  assignTask(id: string): Effect.Effect<Task, NotFoundError | RepositoryError | ServiceError> {
    const taskRepo = this.taskRepo;
    const runService = this.runService;
    const clock = this.clock;
    return Effect.gen(function* () {
      const task = yield* taskRepo.findById(asTaskId(id));
      if (!task) return yield* Effect.fail(new NotFoundError("Task", id));
      if (task.status !== "queued") {
        return yield* Effect.fail(new ServiceError(`Task is not queued (status ${task.status})`));
      }
      if (!canTransitionTask(task.status, "assigned")) {
        return yield* Effect.fail(new ServiceError("Invalid task transition"));
      }
      let assigned: Task = { ...task, status: "assigned", updatedAt: clock.now() };
      yield* taskRepo.update(assigned);
      // Start run.
      const run = yield* runService
        .startRun({
          botId: task.assignee as BotId,
          prompt: task.description,
          triggerType: "task",
          taskId: task.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* taskRepo
                .update({ ...assigned, status: "queued", updatedAt: clock.now() })
                .pipe(Effect.ignore);
              return yield* Effect.fail(new ServiceError(String(Cause.squash(cause))));
            }),
          ),
        );
      if (!canTransitionTask(assigned.status, "running")) {
        return yield* Effect.fail(new ServiceError("Invalid task transition"));
      }
      assigned = {
        ...assigned,
        status: "running",
        resultRunId: run.id,
        updatedAt: clock.now(),
      };
      yield* taskRepo.update(assigned);
      return assigned;
    }) as Effect.Effect<Task, NotFoundError | RepositoryError | ServiceError>;
  }

  /** Create and immediately assign+start. Convenience for simple delegation. */
  delegate(input: CreateTaskInput): Effect.Effect<Task, ValidationError | NotFoundError | RepositoryError | ServiceError> {
    const createTask = this.createTask.bind(this);
    const assignTask = this.assignTask.bind(this);
    return Effect.gen(function* () {
      const task = yield* createTask(input);
      const started = yield* assignTask(String(task.id));
      return started;
    }) as Effect.Effect<Task, ValidationError | NotFoundError | RepositoryError | ServiceError>;
  }

  /** Delegate to multiple assignees in parallel. */
  delegateParallel(
    inputs: readonly CreateTaskInput[],
  ): Effect.Effect<readonly Task[], ValidationError | NotFoundError | RepositoryError | ServiceError> {
    const maxParallel = this.maxParallel;
    const delegate = this.delegate.bind(this);
    if (inputs.length > maxParallel) {
      return Effect.fail(new ServiceError("Parallel delegation limit exceeded"));
    }
    return Effect.all(inputs.map((i) => delegate(i)), { concurrency: "unbounded" }) as Effect.Effect<
      readonly Task[],
      ValidationError | NotFoundError | RepositoryError | ServiceError
    >;
  }

  cancelTask(id: string): Effect.Effect<Task | null, RepositoryError | NotFoundError | ServiceError> {
    const taskRepo = this.taskRepo;
    const runService = this.runService;
    const clock = this.clock;
    return Effect.gen(function* () {
      const task = yield* taskRepo.findById(asTaskId(id));
      if (!task) return null;
      if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
        return task;
      }
      if (task.resultRunId) {
        yield* runService.cancelRun(task.resultRunId as RunId).pipe(Effect.ignore);
      }
      if (!canTransitionTask(task.status, "cancelled")) {
        return yield* Effect.fail(new ServiceError("Invalid task transition"));
      }
      const updated: Task = { ...task, status: "cancelled", updatedAt: clock.now() };
      yield* taskRepo.update(updated);
      return updated;
    }) as Effect.Effect<Task | null, RepositoryError | NotFoundError | ServiceError>;
  }
}

