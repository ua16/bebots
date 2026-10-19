import { describe, expect, it, vi } from "vitest";
import type { BebotsPreloadApi } from "../shared/preload-api";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => undefined) },
}));

describe("preload", () => {
  it("exposes the bebots bridge", async () => {
    await import("./index");
    const { contextBridge } = await import("electron");
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "bebots",
      expect.objectContaining({ platform: expect.any(String) }),
    );
  });

  it("forwards workspace and run calls over IPC", async () => {
    await import("./index");
    const { contextBridge, ipcRenderer } = await import("electron");
    const [, api] = (
      contextBridge.exposeInMainWorld as unknown as {
        mock: { calls: Array<[string, BebotsPreloadApi]> };
      }
    ).mock.calls[0]!;
    const invoke = ipcRenderer.invoke as unknown as { mock: { calls: unknown[][] } };

    await api.workspace.getRoot();
    await api.runs.start({ botId: "b1", prompt: "go" });
    await api.runs.get("r1");
    await api.runs.list({ botId: "b1" });
    await api.runs.cancel("r1");
    await api.runs.events("r1");
    await api.runs.await("r1", 50);

    expect(invoke.mock.calls).toContainEqual(["bebots:workspace:root"]);
    expect(invoke.mock.calls).toContainEqual(["bebots:runs:start", { botId: "b1", prompt: "go" }]);
    expect(invoke.mock.calls).toContainEqual(["bebots:runs:get", "r1"]);
    expect(invoke.mock.calls).toContainEqual(["bebots:runs:list", { botId: "b1" }]);
    expect(invoke.mock.calls).toContainEqual(["bebots:runs:cancel", "r1"]);
    expect(invoke.mock.calls).toContainEqual(["bebots:runs:events", "r1"]);
    expect(invoke.mock.calls).toContainEqual(["bebots:runs:await", "r1", 50]);
  });
});
