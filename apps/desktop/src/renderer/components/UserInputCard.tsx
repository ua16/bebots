import { useState, type KeyboardEvent } from "react";

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

function buildAnswers(
  form: UserInputForm,
  selected: Record<string, string[]>,
  custom: Record<string, string>,
): Record<string, string | string[]> {
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
}

function allFieldsAnswered(
  form: UserInputForm,
  answers: Record<string, string | string[]>,
): boolean {
  return form.fields.every((field) => answers[field.key] !== undefined);
}

/** In-thread ask card: options and optional custom free-text per field. */
export function UserInputCard({ form, busy = false, onSubmit, onDismiss }: UserInputCardProps) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const hasMultiselect = form.fields.some((f) => f.type === "multiselect");

  const submitIfComplete = (
    nextSelected: Record<string, string[]>,
    nextCustom: Record<string, string>,
  ) => {
    const answers = buildAnswers(form, nextSelected, nextCustom);
    if (allFieldsAnswered(form, answers)) onSubmit(answers);
  };

  const chooseOption = (key: string, value: string, multi: boolean) => {
    if (busy) return;
    if (multi) {
      setSelected((prev) => {
        const cur = prev[key] ?? [];
        return {
          ...prev,
          [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value],
        };
      });
      return;
    }
    const nextSelected = { ...selected, [key]: [value] };
    setSelected(nextSelected);
    submitIfComplete(nextSelected, custom);
  };

  const submitCustom = (key: string) => {
    if (busy) return;
    const typed = (custom[key] ?? "").trim();
    if (typed.length === 0) return;
    submitIfComplete(selected, custom);
  };

  const onCustomKeyDown = (key: string, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submitCustom(key);
  };

  const showFormTitle =
    form.title.trim().length > 0 && form.title.trim().toLowerCase() !== "questions";

  return (
    <div className="user-input-card" data-testid="user-input-card">
      {showFormTitle ? <div className="user-input-title">{form.title}</div> : null}
      {form.fields.map((field) => {
        const multi = field.type === "multiselect";
        const allowCustom = field.custom === true || (field.options?.length ?? 0) === 0;
        const header = field.title?.trim() || null;
        const question = field.description?.trim() || field.title?.trim() || field.key;
        return (
          <div key={field.key} className="user-input-field">
            {header && field.description?.trim() ? (
              <div className="user-input-header">{header}</div>
            ) : null}
            <div className="user-input-question">{question}</div>
            <div className="user-input-options">
              {(field.options ?? []).map((opt, index) => {
                const active = (selected[field.key] ?? []).includes(opt.value);
                return (
                  <button
                    key={`${field.key}:${opt.value}:${index}`}
                    type="button"
                    aria-pressed={active}
                    className={"user-input-option" + (active ? " selected" : "")}
                    disabled={busy}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseOption(field.key, opt.value, multi)}
                  >
                    <span
                      className={
                        "user-input-option-mark" + (multi ? " multi" : "") + (active ? " on" : "")
                      }
                      aria-hidden
                    />
                    <span className="user-input-option-text">
                      <span className="user-input-option-label">{opt.label}</span>
                      {opt.description && opt.description !== opt.label ? (
                        <span className="user-input-option-desc">{opt.description}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {allowCustom ? (
              <div className="user-input-custom-row">
                <input
                  className="user-input-custom"
                  type="text"
                  disabled={busy}
                  placeholder="Type your own answer"
                  value={custom[field.key] ?? ""}
                  onChange={(e) =>
                    setCustom((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  onKeyDown={(e) => onCustomKeyDown(field.key, e)}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="user-input-actions">
        {hasMultiselect ? (
          <button
            type="button"
            className="user-input-action"
            disabled={busy}
            onClick={() => {
              const answers = buildAnswers(form, selected, custom);
              if (Object.keys(answers).length > 0) onSubmit(answers);
            }}
          >
            Done
          </button>
        ) : null}
        <button
          type="button"
          className="user-input-action user-input-action-muted"
          disabled={busy}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
