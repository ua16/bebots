import { describe, expect, it } from "vitest";
import { assertNever } from "./index";

describe("assertNever", () => {
  it("throws with the stringified value", () => {
    expect(() => assertNever("unexpected" as never)).toThrow(/Unexpected value: unexpected/);
  });
});
