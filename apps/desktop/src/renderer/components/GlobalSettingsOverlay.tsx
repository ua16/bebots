import { X } from "lucide-react";
import type { ApiModel } from "../lib/api-types";
import type { ModelSelection } from "../lib/model-selection";
import { ModelSelect, RUNTIME_DEFAULT_OPTION } from "./ModelSelect";

interface GlobalSettingsOverlayProps {
  readonly open: boolean;
  readonly defaultModelSelection: ModelSelection;
  readonly onSelectDefaultModel: (selection: ModelSelection) => void;
  readonly modelGroups: ReadonlyArray<[string, readonly ApiModel[]]>;
  readonly onSave: () => void;
  readonly onClose: () => void;
}

/** Global settings modal: the app-wide default model for bots with no override. */
export function GlobalSettingsOverlay({
  open,
  defaultModelSelection,
  onSelectDefaultModel,
  modelGroups,
  onSave,
  onClose,
}: GlobalSettingsOverlayProps) {
  if (!open) return null;
  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Global settings">
      <section className="global-settings">
        <div className="overlay-head">
          <h2>Global settings</h2>
          <button
            type="button"
            className="icon-pill-button"
            aria-label="Close global settings"
            onClick={onClose}
          >
            <X size={18} strokeWidth={2.1} aria-hidden />
          </button>
        </div>
        <label className="settings-field">
          <span>Default model (bots without an override)</span>
          <ModelSelect
            selection={defaultModelSelection}
            onSelect={onSelectDefaultModel}
            modelGroups={modelGroups}
            defaultOption={RUNTIME_DEFAULT_OPTION()}
          />
        </label>
        <div className="actions">
          <button type="button" className="pill-button" onClick={onSave}>
            Save settings
          </button>
        </div>
      </section>
    </div>
  );
}
