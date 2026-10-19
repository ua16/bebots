import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
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
});
