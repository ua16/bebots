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

function buildAnswers(
  form: UserInputForm,
  selected: Record<string, string[]>,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  for (const field of form.fields) {
    const picks = selected[field.key] ?? [];
    if (picks.length === 0) continue;
    answers[field.key] = field.type === "multiselect" ? picks : picks[0]!;
  }
  return answers;
}

function allFieldsAnswered(
  form: UserInputForm,
  answers: Record<string, string | string[]>,
): boolean {
  return form.fields.every((field) => answers[field.key] !== undefined);
}

/** Map composer free-text to form answers (alternate to picking an option). */
export function answersFromComposerDraft(
  form: UserInputForm,
  draft: string,
): Record<string, string | string[]> | null {
  const text = draft.trim();
  if (text.length === 0) return null;
  const customFields = form.fields.filter(
    (f) => f.custom === true || (f.options?.length ?? 0) === 0,
  );
  const field = (customFields.length > 0 ? customFields : form.fields)[0];
  if (!field) return null;
  return { [field.key]: field.type === "multiselect" ? [text] : text };
}

/** True when the composer should accept a free-text alternate answer. */
export function formAllowsComposerAnswer(form: UserInputForm): boolean {
  return form.fields.some((f) => f.custom === true || (f.options?.length ?? 0) === 0);
}

/** In-thread ask card: option rows; free-text alternate goes through the composer. */
export function UserInputCard({ form, busy = false, onSubmit, onDismiss }: UserInputCardProps) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const hasMultiselect = form.fields.some((f) => f.type === "multiselect");

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
    const answers = buildAnswers(form, nextSelected);
    if (allFieldsAnswered(form, answers)) onSubmit(answers);
  };

  const showFormTitle =
    form.title.trim().length > 0 && form.title.trim().toLowerCase() !== "questions";

  return (
    <div className="user-input-card" data-testid="user-input-card">
      {showFormTitle ? <div className="user-input-title">{form.title}</div> : null}
      {form.fields.map((field) => {
        const multi = field.type === "multiselect";
        const header = field.title?.trim() || null;
        const question = field.description?.trim() || field.title?.trim() || field.key;
        return (
          <div key={field.key} className="user-input-field">
            {header && field.description?.trim() ? (
              <div className="user-input-header">{header}</div>
            ) : null}
            <div className="user-input-question">{question}</div>
            {(field.options?.length ?? 0) > 0 ? (
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
                          "user-input-option-mark" +
                          (multi ? " multi" : "") +
                          (active ? " on" : "")
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
              const answers = buildAnswers(form, selected);
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
