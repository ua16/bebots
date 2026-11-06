import { Effect, Schema } from "effect";
import type { ModelRef } from "@bebots/domain";
import { ModelRefPatchSchema, parseModelRef, serializeModelRef } from "@bebots/domain";
import type { SettingsRepository } from "./repositories.js";
import { type RepositoryError, ValidationError } from "./errors.js";

export const DEFAULT_MODEL_KEY = "default_model";

/**
 * App-wide mutable settings backed by a key/value setting repository.
 * Currently only the default model; a ModelRef applies to every bot that
 * does not set its own model override.
 */
export class AppSettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  getDefaultModel(): Effect.Effect<ModelRef | null, RepositoryError> {
    return Effect.map(this.repo.get(DEFAULT_MODEL_KEY), (raw) => parseModelRef(raw));
  }

  setDefaultModel(model: ModelRef | null): Effect.Effect<void, RepositoryError | ValidationError> {
    let validated: ModelRef | null;
    try {
      validated = Schema.decodeUnknownSync(ModelRefPatchSchema)(model) ?? null;
    } catch {
      return Effect.fail(new ValidationError("model", "Invalid model reference"));
    }
    return Effect.asVoid(this.repo.set(DEFAULT_MODEL_KEY, serializeModelRef(validated)));
  }
}
