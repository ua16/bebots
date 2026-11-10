import { parseModelRef } from "@bebots/domain";
import type { ApiModel, ApiModelRef } from "./api-types";

/**
 * A model-picker selection: which model (if any) to run with, expressed as a
 * union so the two "use no specific model" meanings — follow the app default
 * (bot editor) and use OpenCode's own default (app settings) — stay distinct.
 */
export type ModelSelection =
  | { readonly kind: "app-default" }
  | { readonly kind: "runtime-default" }
  | { readonly kind: "ref"; readonly ref: ApiModelRef };

export const APP_DEFAULT_KEY = "default";
export const RUNTIME_DEFAULT_KEY = "none";

/** A <select> value must be a string, so refs travel JSON-encoded. */
export function selectionToSelectValue(selection: ModelSelection): string {
  if (selection.kind === "app-default") return APP_DEFAULT_KEY;
  if (selection.kind === "runtime-default") return RUNTIME_DEFAULT_KEY;
  return JSON.stringify(selection.ref);
}

/** Select value for a catalog model — canonical ref only, so the
 *  `onChange` round-trip through the domain parser reproduces it exactly
 *  (the full `ApiModel` carries extra keys the parser strips). */
export function modelToSelectValue(m: ApiModel): string {
  return JSON.stringify({ providerID: m.providerID, id: m.id });
}

/** Inverse of `selectionToSelectValue`; `null` signals an unparseable key. */
export function selectValueToSelection(value: string): ModelSelection | null {
  if (value === APP_DEFAULT_KEY) return { kind: "app-default" };
  if (value === RUNTIME_DEFAULT_KEY) return { kind: "runtime-default" };
  // Shared domain parser — the UI does not re-implement model-ref validation.
  const ref = parseModelRef(value);
  return ref ? { kind: "ref", ref } : null;
}

/** A saved model on a bot: `null` means "follow the app default". */
export function botModelToSelection(ref: ApiModelRef | null | undefined): ModelSelection {
  return ref ? { kind: "ref", ref } : { kind: "app-default" };
}

/** The user's saved app default; `null` means "OpenCode default". */
export function appDefaultToSelection(ref: ApiModelRef | null | undefined): ModelSelection {
  return ref ? { kind: "ref", ref } : { kind: "runtime-default" };
}

/** The model override (or explicit `null`) implied by a selection. */
export function selectionToApiModel(selection: ModelSelection): ApiModelRef | null {
  return selection.kind === "ref" ? selection.ref : null;
}

/** Group the model catalog by provider (stable, response order) for optgroups. */
export function groupModelsByProvider(
  models: readonly ApiModel[],
): ReadonlyArray<[string, readonly ApiModel[]]> {
  const groups = new Map<string, ApiModel[]>();
  for (const m of models) {
    const list = groups.get(m.providerID) ?? [];
    list.push(m);
    groups.set(m.providerID, list);
  }
  return [...groups.entries()];
}
