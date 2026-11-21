import { Effect, Schema } from "effect";
import type { Bot, BotAvatar, BotId, BotStatus, ModelRef } from "@bebots/domain";
import { asBotId, avatarFromBotId, ModelRefPatchSchema, validateBotAvatar } from "@bebots/domain";
import type { BotRepository, BotWorkspace, Clock, IdGenerator } from "./repositories.js";
import { NotFoundError, RepositoryError, ValidationError, WorkspaceError } from "./errors.js";

export interface CreateBotInput {
  readonly name: string;
  readonly description?: string;
  readonly persona?: string;
  /** Per-bot model override. */
  readonly model?: ModelRef | null;
  readonly avatar?: BotAvatar;
}

export interface UpdateBotInput {
  readonly name?: string;
  readonly description?: string;
  readonly persona?: string;
  readonly status?: BotStatus;
  /** Per-bot model override; `null` clears it (fall back to app default). */
  readonly model?: ModelRef | null;
  readonly avatar?: BotAvatar;
}

function validateName(name: string): void {
  if (name.trim().length === 0) {
    throw new ValidationError("name", "Bot name cannot be empty");
  }
  if (name.length > 120) {
    throw new ValidationError("name", "Bot name is too long");
  }
}

function decodeAvatar(value: unknown): BotAvatar {
  const validated = validateBotAvatar(value);
  if (validated.valid === false) {
    throw new ValidationError(validated.field, validated.message);
  }
  return validated.value;
}

export interface BotServiceDeps {
  readonly repo: BotRepository;
  readonly workspace: BotWorkspace;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class BotService {
  private readonly repo: BotRepository;
  private readonly workspace: BotWorkspace;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(deps: BotServiceDeps) {
    this.repo = deps.repo;
    this.workspace = deps.workspace;
    this.clock = deps.clock;
    this.ids = deps.ids;
  }

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
      let model: ModelRef | null;
      try {
        model = Schema.decodeUnknownSync(ModelRefPatchSchema)(input.model) ?? null;
      } catch {
        return yield* Effect.fail(new ValidationError("model", "Invalid model reference"));
      }
      let avatar: BotAvatar | undefined;
      if (input.avatar !== undefined) {
        try {
          avatar = decodeAvatar(input.avatar);
        } catch (e) {
          return yield* Effect.fail(e as ValidationError);
        }
      }
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
        avatar: avatar ?? avatarFromBotId(id),
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
      let decodedModel: ModelRef | null | undefined = undefined;
      let hasModel = false;
      if (input.model !== undefined) {
        try {
          decodedModel = Schema.decodeUnknownSync(ModelRefPatchSchema)(input.model) ?? null;
        } catch {
          return yield* Effect.fail(new ValidationError("model", "Invalid model reference"));
        }
        hasModel = true;
      }
      let decodedAvatar: BotAvatar | undefined;
      let hasAvatar = false;
      if (input.avatar !== undefined) {
        try {
          decodedAvatar = decodeAvatar(input.avatar);
          hasAvatar = true;
        } catch (e) {
          return yield* Effect.fail(e as ValidationError);
        }
      }
      const updated: Bot = {
        ...existing,
        name: input.name !== undefined ? input.name.trim() : existing.name,
        description:
          input.description !== undefined ? input.description.trim() : existing.description,
        persona: input.persona !== undefined ? input.persona : existing.persona,
        status: input.status !== undefined ? input.status : existing.status,
        ...(hasModel && { model: decodedModel ?? null }),
        ...(hasAvatar && decodedAvatar !== undefined && { avatar: decodedAvatar }),
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
