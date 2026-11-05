import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, mcpRpc, type BootedApp } from "./test-boot";

vi.mock("@bebots/runtime-opencode", () => import("./fake-runtime"));

describe("mcp HTTP endpoint", () => {
  let app: BootedApp;

  beforeEach(async () => {
    app = await bootTestApp({
      tmpPrefix: "bebots-mcp-",
      env: { ELECTRON_RENDERER_URL: "http://localhost:5173" },
    });
  });

  afterEach(() => {
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

  it("initializes and lists tools", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);

    await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const tools = await rpc("tools/list");
    expect(tools.status).toBe(200);
    const names = (tools.body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("list_bots");
    expect(names).toContain("send_message");
    expect(names).toContain("create_task");
  });

  it("list_bots returns empty initially", async () => {
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    const res = await rpc("tools/call", { name: "list_bots", arguments: {} }, 2, {
      "X-Bebots-Bot-Id": "bot-x",
    });
    expect(res.status).toBe(200);
    const text = res.body.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([]);
  });
});
