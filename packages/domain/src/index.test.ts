import { describe, expect, it } from "vitest";
import { asBotId, asRunId, canTransitionTask, canTransitionApproval } from "./index";

describe("asBotId", () => {
  it("accepts a non-empty value", () => {
    expect(asBotId("bot-1")).toBe("bot-1");
  });

  it("rejects an empty value", () => {
    expect(() => asBotId("")).toThrow();
  });

  it("rejects a whitespace-only value", () => {
    expect(() => asBotId("   ")).toThrow();
  });
});

describe("task transitions", () => {
  it("allows queued -> assigned", () => {
    expect(canTransitionTask("queued", "assigned")).toBe(true);
  });

  it("allows running -> awaiting_approval", () => {
    expect(canTransitionTask("running", "awaiting_approval")).toBe(true);
  });

  it("allows awaiting_approval -> running", () => {
    expect(canTransitionTask("awaiting_approval", "running")).toBe(true);
  });

  it("rejects succeeded -> running", () => {
    expect(canTransitionTask("succeeded", "running")).toBe(false);
  });

  it("rejects cancelled -> queued", () => {
    expect(canTransitionTask("cancelled", "queued")).toBe(false);
  });
});

describe("approval transitions", () => {
  it("allows pending -> approved", () => {
    expect(canTransitionApproval("pending", "approved")).toBe(true);
  });

  it("allows pending -> rejected", () => {
    expect(canTransitionApproval("pending", "rejected")).toBe(true);
  });

  it("rejects approved -> pending", () => {
    expect(canTransitionApproval("approved", "pending")).toBe(false);
  });
});

describe("asRunId", () => {
  it("accepts a non-empty value", () => {
    expect(asRunId("run-1")).toBe("run-1");
  });

  it("rejects an empty value", () => {
    expect(() => asRunId("")).toThrow();
  });

  it("rejects a whitespace-only value", () => {
    expect(() => asRunId("   ")).toThrow();
  });
});
