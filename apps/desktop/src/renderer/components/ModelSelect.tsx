import type { ApiModel } from "../lib/api-types";
import {
  APP_DEFAULT_KEY,
  RUNTIME_DEFAULT_KEY,
  modelToSelectValue,
  selectValueToSelection,
  selectionToSelectValue,
  type ModelSelection,
} from "../lib/model-selection";

interface ModelSelectProps {
  readonly selection: ModelSelection;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly modelGroups: ReadonlyArray<[string, readonly ApiModel[]]>;
  /** Label of the leading "use no specific model" option ("none" semantics). */
  readonly defaultOption: { readonly value: string; readonly label: string };
}

/** The shared model catalog <select> with provider optgroups. */
export function ModelSelect({ selection, onSelect, modelGroups, defaultOption }: ModelSelectProps) {
  return (
    <select
      value={selectionToSelectValue(selection)}
      onChange={(e) => {
        const next = selectValueToSelection(e.target.value);
        if (next) onSelect(next);
      }}
    >
      <option value={defaultOption.value}>{defaultOption.label}</option>
      {modelGroups.map(([provider, items]) => (
        <optgroup key={provider} label={provider}>
          {items.map((m) => (
            <option key={`${m.providerID}/${m.id}`} value={modelToSelectValue(m)}>
              {m.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Leading option for the bot editor: follow the app default (or "Global
 *  Default" when the user hasn't set one, i.e. the same runtime default). */
export const BOT_APP_DEFAULT_OPTION = (defaultModelSelection: ModelSelection) => ({
  value: APP_DEFAULT_KEY,
  label: defaultModelSelection.kind === "runtime-default" ? "Global Default" : "Use app default",
});

/** Leading option for global settings: OpenCode's own default. */
export const RUNTIME_DEFAULT_OPTION = () => ({
  value: RUNTIME_DEFAULT_KEY,
  label: "OpenCode default",
});
