import { Effect } from "effect";
import type { ModelRef } from "@bebots/domain";
import { parseModelRef, serializeModelRef, validateModelRef } from "@bebots/domain";
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

  setDefaultModel(
    model: ModelRef | null,
  ): Effect.Effect<void, RepositoryError | ValidationError> {
    const validated = validateModelRef(model);
    if (!validated.valid) {
      return Effect.fail(new ValidationError(validated.field, validated.message));
    }
    return Effect.asVoid(
      this.repo.set(DEFAULT_MODEL_KEY, serializeModelRef(validated.value ?? null)),
    );
  }
}
