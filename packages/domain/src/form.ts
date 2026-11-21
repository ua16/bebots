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

export interface PendingRunInput {
  readonly formId: FormId;
  readonly inputDeadlineAt: number;
}
