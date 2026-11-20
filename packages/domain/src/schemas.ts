import { Schema, SchemaGetter } from "effect";
import { MIN_INTERVAL_MS, parseCronFields } from "./schedule.js";

export const ModelRefSchema = Schema.Struct({
  providerID: Schema.Trim.check(Schema.isMinLength(1)),
  id: Schema.Trim.check(Schema.isMinLength(1)),
});

export const ModelRefPatchSchema = Schema.Union([Schema.Undefined, Schema.Null, ModelRefSchema]);

export const BotAvatarSchema = Schema.Struct({
  face: Schema.String,
  color: Schema.Number,
  shape: Schema.String,
});

export const BotIdSchema = Schema.String.pipe(Schema.brand("BotId"));
export const RunIdSchema = Schema.String.pipe(Schema.brand("RunId"));
export const TaskIdSchema = Schema.String.pipe(Schema.brand("TaskId"));
export const ActivityIdSchema = Schema.String.pipe(Schema.brand("ActivityId"));
export const ConversationIdSchema = Schema.String.pipe(Schema.brand("ConversationId"));
export const MessageIdSchema = Schema.String.pipe(Schema.brand("MessageId"));
export const ConversationSessionIdSchema = Schema.String.pipe(
  Schema.brand("ConversationSessionId"),
);
export const ScheduleIdSchema = Schema.String.pipe(Schema.brand("ScheduleId"));
export const ScheduleOccurrenceIdSchema = Schema.String.pipe(Schema.brand("ScheduleOccurrenceId"));

const IntervalTrigger = Schema.Struct({
  kind: Schema.Literal("interval"),
  everyMs: Schema.Number.check(
    Schema.makeFilter((n: number) => Number.isFinite(n) && n > 0 && n >= MIN_INTERVAL_MS, {
      message: "Trigger everyMs must be a positive number at or above the minimum interval",
    }),
  ).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((n: number) => Math.floor(n)),
      encode: SchemaGetter.transform((n: number) => n),
    }),
  ),
});

const OnceTrigger = Schema.Struct({
  kind: Schema.Literal("once"),
  at: Schema.Number.check(
    Schema.makeFilter((n: number) => Number.isFinite(n), {
      message: "Trigger at must be an epoch-milliseconds number",
    }),
  ).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((n: number) => Math.floor(n)),
      encode: SchemaGetter.transform((n: number) => n),
    }),
  ),
});

const CronTrigger = Schema.Struct({
  kind: Schema.Literal("cron"),
  expression: Schema.Trim.check(Schema.isMinLength(1)).check(
    Schema.makeFilter((s: string) => parseCronFields(s) !== null, {
      message: "Trigger expression is not a valid 5-field cron expression",
    }),
  ),
  timezone: Schema.Trim.check(Schema.isMinLength(1)).check(
    Schema.makeFilter(
      (tz: string) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: "Trigger timezone is not a valid IANA timezone" },
    ),
  ),
});

export const ScheduleTriggerSchema = Schema.Union([IntervalTrigger, OnceTrigger, CronTrigger]);
