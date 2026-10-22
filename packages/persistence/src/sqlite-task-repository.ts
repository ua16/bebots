import { Effect } from "effect";
import type { Task, TaskId, TaskStatus } from "@bebots/domain";
import { asTaskId } from "@bebots/domain";
import type { TaskRepository } from "@bebots/application";
import { NotFoundError, RepositoryError } from "@bebots/application";
import type { SqliteDatabase } from "./database.js";

interface TaskRow {
  id: string;
  requester: string | null;
  assignee: string;
  description: string;
  input_refs: string;
  priority: number;
  status: string;
  deadline: number | null;
  result_run_id: string | null;
  result_summary: string | null;
  depth: number;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTask(row: TaskRow): Task {
  let inputRefs: string[] = [];
  try {
    const parsed = JSON.parse(row.input_refs);
    if (Array.isArray(parsed)) inputRefs = parsed.map(String);
  } catch {
    inputRefs = [];
  }
  return {
    id: asTaskId(row.id),
    requester: row.requester,
    assignee: row.assignee,
    description: row.description,
    inputRefs,
    priority: row.priority,
    status: row.status as TaskStatus,
    deadline: row.deadline ?? undefined,
    resultRunId: row.result_run_id ? (row.result_run_id as Task["resultRunId"]) : undefined,
    resultSummary: row.result_summary ?? undefined,
    depth: row.depth,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as Task;
}

export class SqliteTaskRepository implements TaskRepository {
  private readonly db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(task: Task): Effect.Effect<Task, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        db.prepare(
          `INSERT INTO tasks (id, requester, assignee, description, input_refs, priority, status, deadline, result_run_id, result_summary, depth, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          task.id,
          task.requester,
          task.assignee,
          task.description,
          JSON.stringify(task.inputRefs ?? []),
          task.priority,
          task.status,
          task.deadline ?? null,
          task.resultRunId ?? null,
          task.resultSummary ?? null,
          task.depth,
          task.idempotencyKey ?? null,
          task.createdAt,
          task.updatedAt,
        );
        return task;
      },
      catch: (cause) => new RepositoryError("Failed to create task", cause),
    });
  }

  findById(id: TaskId): Effect.Effect<Task | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(id)) as TaskRow | undefined;
        return row ? rowToTask(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find task", cause),
    });
  }

  findAll(options?: {
    readonly requester?: string;
    readonly assignee?: string;
    readonly status?: TaskStatus;
    readonly limit?: number;
  }): Effect.Effect<readonly Task[], RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (options?.requester !== undefined) {
          clauses.push("requester = ?");
          params.push(options.requester);
        }
        if (options?.assignee !== undefined) {
          clauses.push("assignee = ?");
          params.push(options.assignee);
        }
        if (options?.status !== undefined) {
          clauses.push("status = ?");
          params.push(options.status);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = options?.limit ? `LIMIT ${Number(options.limit)}` : "";
        const rows = db
          .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC ${limit}`)
          .all(...params) as unknown as TaskRow[];
        return rows.map(rowToTask);
      },
      catch: (cause) => new RepositoryError("Failed to list tasks", cause),
    });
  }

  update(task: Task): Effect.Effect<Task, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () =>
          db
            .prepare(
              `UPDATE tasks SET requester = ?, assignee = ?, description = ?, input_refs = ?, priority = ?, status = ?, deadline = ?, result_run_id = ?, result_summary = ?, depth = ?, idempotency_key = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              task.requester,
              task.assignee,
              task.description,
              JSON.stringify(task.inputRefs ?? []),
              task.priority,
              task.status,
              task.deadline ?? null,
              task.resultRunId ?? null,
              task.resultSummary ?? null,
              task.depth,
              task.idempotencyKey ?? null,
              task.updatedAt,
              task.id,
            ).changes,
        catch: (cause) => new RepositoryError("Failed to update task", cause),
      });
      if (result === 0) return yield* Effect.fail(new NotFoundError("Task", task.id));
      return task;
    });
  }

  delete(id: TaskId): Effect.Effect<void, RepositoryError | NotFoundError> {
    const db = this.db;
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => db.prepare("DELETE FROM tasks WHERE id = ?").run(String(id)).changes,
        catch: (cause) => new RepositoryError("Failed to delete task", cause),
      });
      if (result === 0) return yield* Effect.fail(new NotFoundError("Task", String(id)));
    });
  }

  findByIdempotencyKey(key: string): Effect.Effect<Task | null, RepositoryError> {
    const db = this.db;
    return Effect.try({
      try: () => {
        const row = db.prepare("SELECT * FROM tasks WHERE idempotency_key = ?").get(key) as TaskRow | undefined;
        return row ? rowToTask(row) : null;
      },
      catch: (cause) => new RepositoryError("Failed to find task by idempotency key", cause),
    });
  }
}

export function createSqliteTaskRepository(db: SqliteDatabase): TaskRepository {
  return new SqliteTaskRepository(db);
}