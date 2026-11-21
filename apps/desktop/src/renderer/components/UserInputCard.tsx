import { useState } from "react";

export interface UserInputOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface UserInputField {
  readonly key: string;
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  readonly custom?: boolean;
  readonly options?: readonly UserInputOption[];
}

export interface UserInputForm {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly UserInputField[];
}

interface UserInputCardProps {
  readonly form: UserInputForm;
  readonly busy?: boolean;
  readonly onSubmit: (answers: Record<string, string | string[]>) => void;
  readonly onDismiss: () => void;
}

/** In-thread ask card: options and optional custom free-text per field. */
export function UserInputCard({ form, busy = false, onSubmit, onDismiss }: UserInputCardProps) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const toggle = (key: string, value: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[key] ?? [];
      if (multi) {
        return {
          ...prev,
          [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value],
        };
      }
      return { ...prev, [key]: [value] };
    });
  };

  const buildAnswers = (): Record<string, string | string[]> => {
    const answers: Record<string, string | string[]> = {};
    for (const field of form.fields) {
      const picks = selected[field.key] ?? [];
      const typed = (custom[field.key] ?? "").trim();
      if (field.type === "multiselect") {
        const values = typed.length > 0 ? [...picks, typed] : picks;
        if (values.length > 0) answers[field.key] = values;
      } else if (typed.length > 0) {
        answers[field.key] = typed;
      } else if (picks.length > 0) {
        answers[field.key] = picks[0]!;
      }
    }
    return answers;
  };

  return (
    <div className="user-input-card" data-testid="user-input-card">
      <div className="user-input-title">{form.title}</div>
      {form.fields.map((field) => {
        const multi = field.type === "multiselect";
        const allowCustom = field.custom === true || (field.options?.length ?? 0) === 0;
        return (
          <div key={field.key} className="user-input-field">
            <div className="user-input-question">
              {field.title ?? field.description ?? field.key}
            </div>
            {field.description && field.title ? (
              <div className="user-input-description">{field.description}</div>
            ) : null}
            <div className="user-input-options">
              {(field.options ?? []).map((opt) => {
                const active = (selected[field.key] ?? []).includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={"user-input-option" + (active ? " selected" : "")}
                    disabled={busy}
                    onClick={() => toggle(field.key, opt.value, multi)}
                  >
                    <span className="user-input-option-label">{opt.label}</span>
                    {opt.description ? (
                      <span className="user-input-option-desc">{opt.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {allowCustom ? (
              <input
                className="user-input-custom"
                type="text"
                disabled={busy}
                placeholder="Type your own answer"
                value={custom[field.key] ?? ""}
                onChange={(e) =>
                  setCustom((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
              />
            ) : null}
          </div>
        );
      })}
      <div className="user-input-actions">
        <button
          type="button"
          className="pill-button"
          disabled={busy}
          onClick={() => onSubmit(buildAnswers())}
        >
          Submit
        </button>
        <button type="button" className="pill-button" disabled={busy} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
