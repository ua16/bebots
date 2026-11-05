import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, mcpRpc, type BootedApp } from "./test-boot";

vi.mock("@bebots/runtime-opencode", () => import("./fake-runtime"));

describe("mcp HTTP logging (--show-mcp-logs)", () => {
  let app: BootedApp;
  let logSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    logSpy = vi.fn();
    app = await bootTestApp({
      tmpPrefix: "bebots-mcp-logs-",
      env: { SHOW_MCP_LOGS: "1", ELECTRON_RENDERER_URL: undefined },
      beforeBoot() {
        vi.spyOn(console, "log").mockImplementation(logSpy as never);
      },
    });
  });

  afterEach(() => {
    delete process.env.SHOW_MCP_LOGS;
    vi.restoreAllMocks();
    app.dispose();
  });

  function rpc(
    method: string,
    params?: Record<string, unknown>,
    id: number = 1,
    headers: Record<string, string> = {},
  ) {
    return mcpRpc(app, method, params, id, headers);
  }

  it("logs request and response bodies for /mcp calls", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);

    const res = await rpc("tools/call", { name: "list_bots", arguments: {} }, 2, {
      "X-Bebots-Bot-Id": "bot-x",
    });
    expect(res.status).toBe(200);
    expect(res.body.result?.content?.[0]?.text ?? "").toEqual("[]");

    const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[mcp] -->");
    expect(logged).toContain("[mcp] <--");
    // Request body shows the JSON-RPC method
    expect(logged).toContain('"tools/call"');
    // The caller bot identity is visible in the request log line
    expect(logged).toContain("caller-bot=bot-x");
    // Response body contains the tool payload (expected empty roster)
    expect(logged).toContain('"content"');
    expect(logged).toContain("[]");
  });
});
