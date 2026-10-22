import { Effect } from "effect";
import { asActivityId } from "@bebots/domain";
import type { ActivityEvent } from "@bebots/domain";
import type { ActivityRepository, Clock, IdGenerator } from "./repositories.js";
import { RepositoryError, ValidationError } from "./errors.js";

export interface RecordActivityInput {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorId?: string | null;
  readonly payload?: unknown;
}

export class ActivityService {
  private readonly repo: ActivityRepository | null;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    depsOrRepo?: ActivityRepository | { readonly activityRepo?: ActivityRepository; readonly clock?: Clock; readonly ids?: IdGenerator },
    clock?: Clock,
    ids?: IdGenerator,
  ) {
    let repo: ActivityRepository | null = null;
    let c = clock;
    let i = ids;
    if (depsOrRepo && typeof depsOrRepo === "object" && "activityRepo" in (depsOrRepo as Record<string, unknown>)) {
      const d = depsOrRepo as { readonly activityRepo?: ActivityRepository; readonly clock?: Clock; readonly ids?: IdGenerator };
      repo = d.activityRepo ?? null;
      c = d.clock ?? c;
      i = d.ids ?? i;
    } else if (depsOrRepo) {
      repo = depsOrRepo as ActivityRepository;
    }
    this.repo = repo;
    this.clock = c ?? { now: () => Date.now() };
    this.ids = i ?? { generate: () => crypto.randomUUID() };
  }

  record(input: RecordActivityInput): Effect.Effect<ActivityEvent, RepositoryError | ValidationError> {
    const repo = this.repo;
    const clock = this.clock;
    const ids = this.ids;
    return Effect.gen(function* () {
      if (!repo) {
        return yield* Effect.fail(new ValidationError("activityRepo", "Activity repository required"));
      }
      const now = clock.now();
      const event: ActivityEvent = {
        id: asActivityId(ids.generate()),
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        actorId: input.actorId ?? null,
        payload: input.payload,
        createdAt: now,
      };
      return yield* repo.create(event);
    });
  }

  list(options?: {
    readonly type?: string;
    readonly entityType?: string;
    readonly entityId?: string;
    readonly limit?: number;
  }): Effect.Effect<readonly ActivityEvent[], RepositoryError | ValidationError> {
    const repo = this.repo;
    return Effect.gen(function* () {
      if (!repo) {
        return yield* Effect.fail(new ValidationError("activityRepo", "Activity repository required"));
      }
      return yield* repo.findAll(options);
    });
  }
}