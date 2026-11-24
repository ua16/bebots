export type FormId = string & { readonly __brand: "FormId" };

export function asFormId(value: string): FormId {
  if (value.trim().length === 0) {
    throw new Error("FormId cannot be empty");
  }
  return value as FormId;
}

export interface FormOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface FormWhen {
  readonly key: string;
  readonly op: "eq" | "neq";
  readonly value: string | number | boolean;
}

interface FormFieldBase {
  readonly key: string;
  readonly title?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly hidden?: boolean;
  readonly when?: readonly FormWhen[];
}

export interface FormStringField extends FormFieldBase {
  readonly type: "string";
  readonly format?: "email" | "uri" | "date" | "date-time";
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly placeholder?: string;
  readonly default?: string;
  readonly options?: readonly FormOption[];
  readonly custom?: boolean;
}

export interface FormNumberField extends FormFieldBase {
  readonly type: "number";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
}

export interface FormIntegerField extends FormFieldBase {
  readonly type: "integer";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
}

export interface FormBooleanField extends FormFieldBase {
  readonly type: "boolean";
  readonly default?: boolean;
}

export interface FormMultiselectField extends FormFieldBase {
  readonly type: "multiselect";
  readonly options: readonly FormOption[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly custom?: boolean;
  readonly default?: readonly string[];
}

export interface FormExternalField extends FormFieldBase {
  readonly type: "external";
  readonly url: string;
}

export type FormField =
  | FormStringField
  | FormNumberField
  | FormIntegerField
  | FormBooleanField
  | FormMultiselectField
  | FormExternalField;

export type FormAnswerValue = string | number | boolean | ReadonlyArray<string>;

export type FormAnswers = Readonly<Record<string, FormAnswerValue>>;

export interface Form {
  readonly id: FormId;
  readonly sessionId: string;
  readonly title: string;
  readonly fields: readonly FormField[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Desktop v1 can render these; richer shapes are declined. */
export function isDesktopRenderableForm(form: Form): boolean {
  for (const field of form.fields) {
    if (field.type === "external") return false;
    if (field.type !== "string" && field.type !== "multiselect") return false;
    if (field.hidden === true) return false;
    if ((field.when?.length ?? 0) > 0) return false;
  }
  return form.fields.length > 0;
}

export interface FormFieldWire {
  readonly key: string;
  readonly type: FormField["type"];
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly required?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  readonly custom?: boolean | undefined;
  readonly options?:
    | readonly {
        readonly value: string;
        readonly label: string;
        readonly description?: string | undefined;
      }[]
    | undefined;
  readonly url?: string | undefined;
}

export interface FormWire {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly fields: readonly FormFieldWire[];
}

function optionsFromWire(options: FormFieldWire["options"]): readonly FormOption[] | undefined {
  if (options === undefined) return undefined;
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
  }));
}

function fieldFromWire(field: FormFieldWire): FormField {
  const base = {
    key: field.key,
    ...(field.title !== undefined ? { title: field.title } : {}),
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...(field.required !== undefined ? { required: field.required } : {}),
    ...(field.hidden !== undefined ? { hidden: field.hidden } : {}),
  };
  const options = optionsFromWire(field.options);
  switch (field.type) {
    case "string":
      return {
        ...base,
        type: "string",
        ...(field.custom !== undefined ? { custom: field.custom } : {}),
        ...(options !== undefined ? { options } : {}),
      };
    case "multiselect":
      return {
        ...base,
        type: "multiselect",
        options: options ?? [],
        ...(field.custom !== undefined ? { custom: field.custom } : {}),
      };
    case "external":
      return {
        ...base,
        type: "external",
        url: field.url ?? "",
      };
    case "number":
    case "integer":
    case "boolean":
      return { ...base, type: field.type };
  }
}

export function formFromWire(raw: FormWire): Form {
  return {
    id: asFormId(raw.id),
    sessionId: raw.sessionId,
    title: raw.title,
    fields: raw.fields.map(fieldFromWire),
  };
}

export interface PendingRunInput {
  readonly formId: FormId;
  readonly inputDeadlineAt: number;
}

export const ASK_ANSWER_MARKER_KIND = "ask-answer" as const;

export interface AskAnswerMarker {
  readonly kind: typeof ASK_ANSWER_MARKER_KIND;
  readonly question: string;
  readonly answer: string;
}

/** Persist ask Q&A as a structured system-message body. */
export function encodeAskAnswerMarker(question: string, answer: string): string {
  const marker: AskAnswerMarker = {
    kind: ASK_ANSWER_MARKER_KIND,
    question,
    answer,
  };
  return JSON.stringify(marker);
}

/** Parse a system-message body into an ask marker, or null if unrelated. */
export function parseAskAnswerMarker(content: string): AskAnswerMarker | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AskAnswerMarker>;
    if (
      parsed.kind !== ASK_ANSWER_MARKER_KIND ||
      typeof parsed.question !== "string" ||
      typeof parsed.answer !== "string"
    ) {
      return null;
    }
    return {
      kind: ASK_ANSWER_MARKER_KIND,
      question: parsed.question,
      answer: parsed.answer,
    };
  } catch {
    return null;
  }
}

function optionLabel(options: readonly FormOption[] | undefined, value: string): string {
  const match = options?.find((o) => o.value === value);
  return match?.label ?? value;
}

function formatFieldAnswer(field: FormField, raw: FormAnswerValue): string | null {
  if (field.type === "multiselect") {
    const values = (Array.isArray(raw) ? raw : [raw])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => optionLabel(field.options, v));
    return values.length > 0 ? values.join(", ") : null;
  }
  if (field.type === "string") {
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    return optionLabel(field.options, raw);
  }
  if (typeof raw === "boolean" || typeof raw === "number") return String(raw);
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return null;
}

function fieldQuestion(field: FormField): string {
  const description = field.description?.trim();
  if (description) return description;
  const title = field.title?.trim();
  if (title) return title;
  return field.key;
}

/** One thread marker payload per answered form field. */
export function askAnswerMarkersFromForm(
  form: Form,
  answers: FormAnswers,
): readonly AskAnswerMarker[] {
  const markers: AskAnswerMarker[] = [];
  for (const field of form.fields) {
    const raw = answers[field.key];
    if (raw === undefined) continue;
    const answer = formatFieldAnswer(field, raw);
    if (answer === null) continue;
    markers.push({
      kind: ASK_ANSWER_MARKER_KIND,
      question: fieldQuestion(field),
      answer,
    });
  }
  return markers;
}
