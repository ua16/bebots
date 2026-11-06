// Default fake runtime for the live-boot HTTP suites (PR 5 of the API layer
// foundation refactor). The suites that need run-counting or fresh-session
// behavior (mcp.schedule, mcp.bot-link) keep their own variants; everything
// else imports this through a `vi.mock` factory:
//
//   vi.mock("@bebots/runtime-opencode", () => import("./fake-runtime"));
//
// Every run succeeds immediately with stable ids.
import { Effect, Stream } from "effect";

export class FakeRuntime {
  readonly id = "fake";
  readonly capabilities = {
    streaming: true,
    resumableSessions: true,
    cancellation: true,
  };
  startRun(request: { sessionId?: string }) {
    return Effect.succeed({ runId: "rt-1", sessionId: request.sessionId ?? "sess-1" });
  }
  cancelRun() {
    return Effect.void;
  }
  streamEvents() {
    return Stream.empty;
  }
  getResult() {
    return Effect.succeed({ exitCode: 0, summary: "ok", sessionId: "sess-1" });
  }
  close() {}
}

// The part of the `@bebots/runtime-opencode` module surface the app imports
// (constructor, factory).
export const OpenCodeRuntime = FakeRuntime;
export const createOpenCodeRuntime = () => new FakeRuntime();
