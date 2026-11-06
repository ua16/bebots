/**
 * Schedules (PLAN §9): durable trigger definitions that enqueue runs for a
 * bot at specific times. A scheduled run is just a prompt passed to a bot
 * session at a scheduled time; the schedule owns *when*, the run owns *what*.
 *
 * Trigger kinds:
 * - `interval`: fire every N milliseconds, phase-anchored at creation.
 * - `once`: fire at one exact epoch-millisecond timestamp.
 * - `cron`: fire per a 5-field cron expression resolved in an explicit
 *   IANA timezone (PLAN: "cron-like schedule with an explicit timezone").
 */
import { Schema } from "effect";
import type { BotId, ConversationId, RunId } from "./index.js";
import { ScheduleTriggerSchema } from "./schemas.js";

export type ScheduleId = string & { readonly __brand: "ScheduleId" };

export function asScheduleId(value: string): ScheduleId {
  if (value.trim().length === 0) {
    throw new Error("ScheduleId cannot be empty");
  }
  return value as ScheduleId;
}

export type ScheduleOccurrenceId = string & { readonly __brand: "ScheduleOccurrenceId" };

export function asScheduleOccurrenceId(value: string): ScheduleOccurrenceId {
  if (value.trim().length === 0) {
    throw new Error("ScheduleOccurrenceId cannot be empty");
  }
  return value as ScheduleOccurrenceId;
}

export type ScheduleTrigger =
  | { readonly kind: "interval"; readonly everyMs: number }
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "cron"; readonly expression: string; readonly timezone: string };

/** Smallest interval between two automatic firings — prevents runaway loops. */
export const MIN_INTERVAL_MS = 60_000;

export const SCHEDULE_OCCURRENCE_STATUSES = [
  "pending",
  "enqueued",
  "succeeded",
  "failed",
  "missed",
  "cancelled",
] as const;

export type ScheduleOccurrenceStatus = (typeof SCHEDULE_OCCURRENCE_STATUSES)[number];

export interface Schedule {
  readonly id: ScheduleId;
  readonly botId: BotId;
  /** Task prompt handed to a session when the schedule fires. */
  readonly prompt: string;
  readonly trigger: ScheduleTrigger;
  readonly enabled: boolean;
  /** When present, the run resumes this conversation's stored session. */
  readonly conversationId?: ConversationId | null;
  /** Creator identity: a bot id (via MCP) or null/absent when user-created. */
  readonly createdBy?: string | null;
  /** Phase anchor for `interval` triggers (its creation time). */
  readonly anchorAt: number;
  /** Next due firing, or null when the schedule has no future occurrences. */
  readonly nextRunAt?: number | null;
  readonly lastRunAt?: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ScheduleOccurrence {
  readonly id: ScheduleOccurrenceId;
  readonly scheduleId: ScheduleId;
  /** The wall-clock time the occurrence was supposed to fire. */
  readonly scheduledFor: number;
  readonly status: ScheduleOccurrenceStatus;
  readonly runId?: RunId | null;
  readonly attempts: number;
  readonly error?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Validate untrusted trigger input (HTTP body / MCP arguments). */
export function validateScheduleTrigger(
  trigger: unknown,
):
  | { readonly valid: true; readonly value: ScheduleTrigger }
  | { readonly valid: false; readonly message: string } {
  try {
    const value = Schema.decodeUnknownSync(ScheduleTriggerSchema)(trigger);
    return { valid: true, value };
  } catch (e) {
    const err = e as { message?: string };
    return { valid: false, message: err.message ?? "Invalid trigger" };
  }
}

/**
 * Next firing time strictly after `afterMs`, or null when the trigger can
 * never fire again. `anchorAtMs` phase-aligns interval triggers; absent means
 * epoch-anchored.
 */
export function nextScheduleFire(
  trigger: ScheduleTrigger,
  afterMs: number,
  anchorAtMs?: number,
): number | null {
  switch (trigger.kind) {
    case "once":
      return trigger.at > afterMs ? trigger.at : null;
    case "interval": {
      const every = Math.max(MIN_INTERVAL_MS, trigger.everyMs);
      const anchor = anchorAtMs ?? 0;
      const steps = Math.ceil((afterMs + 1 - anchor) / every);
      const k = Math.max(steps, 1);
      return anchor + k * every;
    }
    case "cron":
      return nextCronFire(trigger.expression, afterMs, trigger.timezone);
  }
}

// ---------------------------------------------------------------------------
// Cron (5 fields: minute hour day-of-month month day-of-week), minute
// granularity, resolved against an IANA timezone so DST shifts stay correct.
// Matching rule follows standard cron: if both day-of-month and day-of-week
// are restricted, a day matching either one fires.
// ---------------------------------------------------------------------------

interface CronFields {
  /** Minutes_of_the hour, sorted; null means every minute. */
  readonly minutes: readonly number[] | null;
  readonly hours: readonly number[] | null;
  readonly dom: readonly number[] | null;
  readonly month: readonly number[] | null;
  readonly dow: readonly number[] | null;
}

function parseCronRange(
  raw: string,
  min: number,
  max: number,
  isDow: boolean,
): number[] | null | "invalid" {
  if (raw === "*") return null;
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    let body = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      body = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return "invalid";
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const parts = body.split("-");
      if (parts.length !== 2) return "invalid";
      lo = Number(parts[0]);
      hi = Number(parts[1]);
    } else {
      lo = Number(body);
      hi = slash >= 0 ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return "invalid";
    if (isDow) {
      // Common cron dialect allows 7 as Sunday; normalize to 0.
      lo = lo === 7 ? 0 : lo;
      hi = hi === 7 ? (hi === lo ? 0 : 6) : hi;
    }
    if (lo < min || hi > max || lo > hi) return "invalid";
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) return "invalid";
  return [...out].sort((a, b) => a - b);
}

export function parseCronFields(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseCronRange(parts[0]!, 0, 59, false);
  const hours = parseCronRange(parts[1]!, 0, 23, false);
  const dom = parseCronRange(parts[2]!, 1, 31, false);
  const month = parseCronRange(parts[3]!, 1, 12, false);
  const dow = parseCronRange(parts[4]!, 0, 6, true);
  if (
    minutes === "invalid" ||
    hours === "invalid" ||
    dom === "invalid" ||
    month === "invalid" ||
    dow === "invalid"
  ) {
    return null;
  }
  return { minutes, hours, dom, month, dow };
}

interface LocalWall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const timeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = timeFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    timeFormatterCache.set(timeZone, f);
  }
  return f;
}

function localWall(epochMs: number, timeZone: string): LocalWall {
  const parts = formatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** Convert a wall-clock time in `timeZone` to a UTC instant (two-pass DST resolution). */
function wallToUtc(wall: LocalWall, timeZone: string): number {
  const desired = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let utc = desired;
  for (let i = 0; i < 2; i++) {
    const current = localWall(utc, timeZone);
    const currentAsUtc = Date.UTC(
      current.year,
      current.month - 1,
      current.day,
      current.hour,
      current.minute,
    );
    if (currentAsUtc === desired) break;
    utc += desired - currentAsUtc;
  }
  return utc;
}

function weekdayOf(year: number, month: number, day: number): number {
  // Weekday is a calendar-date property, so plain UTC arithmetic is exact.
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function advanceDay(
  year: number,
  month: number,
  day: number,
): { readonly year: number; readonly month: number; readonly day: number } {
  const t = new Date(Date.UTC(year, month - 1, day + 1, 12));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

const MAX_CRON_DAY_SCAN = 366 * 5 + 2;

function nextCronFire(expression: string, afterMs: number, timeZone: string): number | null {
  const fields = parseCronFields(expression);
  if (fields === null) return null;

  const start = localWall(afterMs, timeZone);
  let year = start.year;
  let month = start.month;
  let day = start.day;
  // Occurrences on the first scanned day must fall strictly within the rest
  // of that wall-clock day (a minute after the given instant). Allowing
  // equality lets DST fall-back produce a second valid occurrence.
  let firstDay = true;
  const fromHour = start.hour;
  const fromMinute = start.minute + 1;

  for (let scanned = 0; scanned < MAX_CRON_DAY_SCAN; scanned++) {
    if (fields.month !== null && !fields.month.includes(month)) {
      // Jump straight to the next matching month (first day, midnight).
      const next = fields.month.find((m) => m > month) ?? fields.month[0]!;
      const jump =
        next > month
          ? new Date(Date.UTC(year, next - 1, 1, 12))
          : new Date(Date.UTC(year + 1, next - 1, 1, 12));
      year = jump.getUTCFullYear();
      month = jump.getUTCMonth() + 1;
      day = 1;
      firstDay = false;
      continue;
    }
    const domMatch = fields.dom === null || fields.dom.includes(day);
    const dowMatch = fields.dow === null || fields.dow.includes(weekdayOf(year, month, day));
    const dayMatches =
      fields.dom !== null && fields.dow !== null ? domMatch || dowMatch : domMatch && dowMatch;
    if (dayMatches) {
      const hours = fields.hours ?? Array.from({ length: 24 }, (_, h) => h);
      const minutes = fields.minutes ?? Array.from({ length: 60 }, (_, m) => m);
      for (const h of hours) {
        if (firstDay && h < fromHour) continue;
        for (const m of minutes) {
          if (firstDay && h === fromHour && m < fromMinute) continue;
          const fire = wallToUtc({ year, month, day, hour: h, minute: m }, timeZone);
          if (fire > afterMs) return fire;
        }
      }
    }
    ({ year, month, day } = advanceDay(year, month, day));
    firstDay = false;
  }
  return null;
}
