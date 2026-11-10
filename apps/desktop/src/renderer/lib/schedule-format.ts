import type { ApiSchedule } from "./api-types";

/** Short human description of a schedule trigger, e.g. "every 5m" or cron. */
export function describeTrigger(trigger: ApiSchedule["trigger"]): string {
  if (trigger.kind === "interval") {
    const minutes = Math.round(trigger.everyMs / 60_000);
    return minutes % 60 === 0 && minutes >= 60
      ? `every ${Math.round(minutes / 60)}h`
      : `every ${minutes}m`;
  }
  if (trigger.kind === "once") {
    return new Date(trigger.at).toLocaleString();
  }
  return `cron ${trigger.expression} (${trigger.timezone})`;
}
