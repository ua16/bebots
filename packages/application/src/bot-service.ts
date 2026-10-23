import { Effect } from "effect";
import type { Bot, BotId, BotStatus, ModelRef } from "@bebots/domain";
import { asBotId, validateModelRef } from "@bebots/domain";
import type { BotRepository, BotWorkspace, Clock, IdGenerator } from "./repositories.js";
import { NotFoundError, RepositoryError, ValidationError, WorkspaceError } from "./errors.js";

export interface CreateBotInput {
  readonly name: string;
  readonly description?: string;
  readonly persona?: string;
  /** Per-bot model override. */
  readonly model?: ModelRef | null;
}

export interface UpdateBotInput {
  readonly name?: string;
  readonly description?: string;
  readonly persona?: string;
  readonly status?: BotStatus;
  /** Per-bot model override; `null` clears it (fall back to app default). */
  readonly model?: ModelRef | null;
}

function validateName(name: string): void {
  if (name.trim().length === 0) {
    throw new ValidationError("name", "Bot name cannot be empty");
  }
  if (name.length > 120) {
    throw new ValidationError("name", "Bot name is too long");
  }
}

export class BotService {
  constructor(
    private readonly repo: BotRepository,
    private readonly workspace: BotWorkspace,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  createBot(
    input: CreateBotInput,
  ): Effect.Effect<Bot, ValidationError | RepositoryError | WorkspaceError> {
    const { repo, workspace, clock, ids } = this;
    return Effect.gen(function* () {
      const name = (input.name ?? "").trim();
      try {
        validateName(name);
      } catch (e) {
        return yield* Effect.fail(e as ValidationError);
      }
      const description = (input.description ?? "").trim();
      const persona = input.persona ?? "";
      const modelValidated = validateModelRef(input.model);
      if (!modelValidated.valid) {
        return yield* Effect.fail(
          new ValidationError(modelValidated.field, modelValidated.message),
        );
      }
      const model = modelValidated.value ?? null;
      let id: BotId;
      try {
        id = asBotId(ids.generate());
      } catch (e) {
        return yield* Effect.fail(
          e instanceof ValidationError ? e : new ValidationError("id", "Invalid bot id"),
        );
      }
      const now = clock.now();
      const bot: Bot = {
        id,
        name,
        description,
        persona,
        status: "active",
        model,
        createdAt: now,
        updatedAt: now,
      };
      yield* repo.create(bot);
      yield* workspace.ensureHome(id);
      yield* workspace.writePersona(id, persona);
      return bot;
    });
  }

  getBot(id: BotId): Effect.Effect<Bot | null, RepositoryError> {
    return this.repo.findById(id);
  }

  listBots(includeArchived = false): Effect.Effect<readonly Bot[], RepositoryError> {
    return this.repo.findAll({ includeArchived });
  }

  updateBot(
    id: BotId,
    input: UpdateBotInput,
  ): Effect.Effect<Bot, ValidationError | NotFoundError | RepositoryError | WorkspaceError> {
    const { repo, workspace, clock } = this;
    return Effect.gen(function* () {
      const existing = yield* repo.findById(id);
      if (!existing) {
        return yield* Effect.fail(new NotFoundError("Bot", id));
      }
      if (input.name !== undefined) {
        try {
          validateName(input.name.trim());
        } catch (e) {
          return yield* Effect.fail(e as ValidationError);
        }
      }
      const modelValidated = validateModelRef(input.model);
      if (!modelValidated.valid) {
        return yield* Effect.fail(
          new ValidationError(modelValidated.field, modelValidated.message),
        );
      }
      const updated: Bot = {
        ...existing,
        name: input.name !== undefined ? input.name.trim() : existing.name,
        description:
          input.description !== undefined ? input.description.trim() : existing.description,
        persona: input.persona !== undefined ? input.persona : existing.persona,
        status: input.status !== undefined ? input.status : existing.status,
        // Only touch the model when the caller sent the field at all
        // (undefined = keep, null = clear, ref = set); see `validateModelRef`.
        ...(input.model !== undefined && { model: modelValidated.value ?? null }),
        updatedAt: clock.now(),
      };
      yield* repo.update(updated);
      if (input.persona !== undefined) {
        yield* workspace.writePersona(id, updated.persona);
      }
      return updated;
    });
  }

  archiveBot(id: BotId): Effect.Effect<Bot, Error> {
    return this.updateBot(id, { status: "archived" });
  }
}
