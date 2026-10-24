import { Effect } from "effect";
import { asActivityId } from "@bebots/domain";
import type { ActivityEvent } from "@bebots/domain";
import type { ActivityRepository, Clock, IdGenerator } from "./repositories.js";
import { RepositoryError } from "./errors.js";

export interface RecordActivityInput {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorId?: string | null;
  readonly payload?: unknown;
}

export interface ActivityServiceDeps {
  readonly activityRepo: ActivityRepository;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export class ActivityService {
  private readonly repo: ActivityRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(deps: ActivityServiceDeps) {
    this.repo = deps.activityRepo;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.ids = deps.ids ?? { generate: () => crypto.randomUUID() };
  }

  record(input: RecordActivityInput): Effect.Effect<ActivityEvent, RepositoryError> {
    const repo = this.repo;
    const clock = this.clock;
    const ids = this.ids;
    return Effect.gen(function* () {
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
  }): Effect.Effect<readonly ActivityEvent[], RepositoryError> {
    const repo = this.repo;
    return Effect.gen(function* () {
      return yield* repo.findAll(options);
    });
  }
}