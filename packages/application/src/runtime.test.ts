import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { AgentRuntime, RunRequest, RunHandle, RuntimeEvent, RunResult } from "./index";

describe("runtime contract", () => {
  it("loads the runtime module", async () => {
    const mod = await import("./index");
    expect(mod).toBeDefined();
  });
  it("executes a trivial effect", async () => {
    const result = await Effect.runPromise(Effect.succeed(42));
    expect(result).toBe(42);
  });

  it("constructs a minimal adapter satisfying AgentRuntime", () => {
    const adapter: AgentRuntime = {
      id: "test",
      capabilities: { streaming: false, resumableSessions: false, cancellation: false },
      startRun: (_request: RunRequest) => Effect.succeed({ runId: "r1" } as RunHandle),
      cancelRun: (_handle: RunHandle) => Effect.void,
      streamEvents: (_handle: RunHandle) => Stream.empty as Stream.Stream<RuntimeEvent, never>,
      getResult: (_handle: RunHandle) =>
        Effect.succeed({ exitCode: 0, summary: "ok" } as RunResult),
    };
    expect(adapter.id).toBe("test");
  });
});
