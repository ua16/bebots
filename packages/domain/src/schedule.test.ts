import { describe, expect, it } from "vitest";
import {
  MIN_INTERVAL_MS,
  nextScheduleFire,
  parseCronFields,
  validateScheduleTrigger,
} from "./schedule";

const U = (iso: string): number => Date.parse(iso);

describe("validateScheduleTrigger", () => {
  it("accepts a valid interval trigger", () => {
    const result = validateScheduleTrigger({ kind: "interval", everyMs: MIN_INTERVAL_MS });
    expect(result.valid).toBe(true);
  });

  it("rejects intervals below the minimum", () => {
    expect(validateScheduleTrigger({ kind: "interval", everyMs: 100 }).valid).toBe(false);
    expect(validateScheduleTrigger({ kind: "interval", everyMs: 0 }).valid).toBe(false);
  });

  it("accepts a valid once trigger", () => {
    expect(validateScheduleTrigger({ kind: "once", at: U("2026-11-01T10:00:00Z") }).valid).toBe(
      true,
    );
    expect(validateScheduleTrigger({ kind: "once", at: Number.NaN }).valid).toBe(false);
  });

  it("accepts a valid cron trigger and rejects bad expressions/timezones", () => {
    expect(
      validateScheduleTrigger({
        kind: "cron",
        expression: "30 9 * * *",
        timezone: "America/New_York",
      }).valid,
    ).toBe(true);
    expect(
      validateScheduleTrigger({
        kind: "cron",
        expression: "61 9 * * *",
        timezone: "America/New_York",
      }).valid,
    ).toBe(false);
    expect(
      validateScheduleTrigger({ kind: "cron", expression: "30 9 * * *", timezone: "Not/AZone" })
        .valid,
    ).toBe(false);
    expect(validateScheduleTrigger({ kind: "wat" }).valid).toBe(false);
  });
});

describe("nextScheduleFire", () => {
  it("interval advances from the anchor in steps", () => {
    const trigger = { kind: "interval", everyMs: MIN_INTERVAL_MS } as const;
    const anchor = U("2026-01-01T00:00:00.500Z");
    expect(nextScheduleFire(trigger, anchor, anchor)).toBe(anchor + MIN_INTERVAL_MS);
    // Skipping whole periods still lands on the next grid point.
    expect(nextScheduleFire(trigger, anchor + 120_000, anchor)).toBe(anchor + 180_000);
    // Before the anchor, the first fire is anchor + everyMs.
    expect(nextScheduleFire(trigger, anchor - 10_000, anchor)).toBe(anchor + MIN_INTERVAL_MS);
  });

  it("once fires only while in the future", () => {
    const trigger = { kind: "once", at: 5_000 } as const;
    expect(nextScheduleFire(trigger, 1_000)).toBe(5_000);
    expect(nextScheduleFire(trigger, 5_000)).toBeNull();
    expect(nextScheduleFire(trigger, 9_999)).toBeNull();
  });

  it("cron fires at the next matching local minute", () => {
    const trigger = {
      kind: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    } as const;
    // 2026-10-26 is during EDT (UTC-4): 09:30 local === 13:30Z.
    expect(nextScheduleFire(trigger, U("2026-10-26T10:00:00Z"))).toBe(U("2026-10-26T13:30:00Z"));
    // Same day earlier: fires later that day.
    expect(nextScheduleFire(trigger, U("2026-10-26T13:31:00Z"))).toBe(U("2026-10-27T13:30:00Z"));
  });

  it("cron respects UTC timezones", () => {
    const trigger = { kind: "cron", expression: "0 * * * *", timezone: "UTC" } as const;
    expect(nextScheduleFire(trigger, U("2026-01-01T05:00:05Z"))).toBe(U("2026-01-01T06:00:00Z"));
  });

  it("cron day-of-week lists and ranges match calendar days", () => {
    const trigger = { kind: "cron", expression: "0 12 * * 6,0", timezone: "UTC" } as const;
    // 2026-10-26 is a Monday → next weekend noon is Saturday 2026-10-31.
    expect(nextScheduleFire(trigger, U("2026-10-26T09:00:00Z"))).toBe(U("2026-10-31T12:00:00Z"));
  });

  it("cron with both dom and dow restricted matches either (standard cron)", () => {
    const trigger = { kind: "cron", expression: "0 0 1 * 1", timezone: "UTC" } as const;
    // 2026-10-26 Monday (dow 1): allowed by dow even though dom 1 doesn't match.
    expect(nextScheduleFire(trigger, U("2026-10-25T09:00:00Z"))).toBe(U("2026-10-26T00:00:00Z"));
  });

  it("cron */n steps work and month jumping skips unmatching months", () => {
    const trigger = { kind: "cron", expression: "0 0 1 */2 *", timezone: "UTC" } as const;
    // Odd months only (1,3,5,7,9,11): after Oct 1 → next is Nov 1, then Jan 1.
    expect(nextScheduleFire(trigger, U("2026-10-02T00:00:00Z"))).toBe(U("2026-11-01T00:00:00Z"));
    expect(nextScheduleFire(trigger, U("2026-11-01T00:00:01Z"))).toBe(U("2027-01-01T00:00:00Z"));
  });
});

describe("parseCronFields", () => {
  it("parses all-asterisk fields to null", () => {
    expect(parseCronFields("* * * * *")).toEqual({
      minutes: null,
      hours: null,
      dom: null,
      month: null,
      dow: null,
    });
  });

  it("rejects malformed fields", () => {
    expect(parseCronFields("60 * * * *")).toBeNull();
    expect(parseCronFields("* * * *")).toBeNull();
    expect(parseCronFields("a b c d e")).toBeNull();
    expect(parseCronFields("0 25 * * *")).toBeNull();
  });
});
