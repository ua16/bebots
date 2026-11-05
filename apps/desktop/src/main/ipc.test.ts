import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type BootedApp } from "./test-boot";

describe("main IPC", () => {
  let app: BootedApp | undefined;

  afterEach(() => {
    app?.dispose();
    app = undefined;
    delete process.env.ELECTRON_RENDERER_URL;
    vi.restoreAllMocks();
  });

  it("registers bot handlers and runs effects", async () => {
    app = await bootTestApp({
      tmpPrefix: "bebots-main-",
      env: { ELECTRON_RENDERER_URL: "http://localhost:5173" },
    });

    expect(app.ipcMain.handle).toHaveBeenCalledWith("bebots:bots:list", expect.any(Function));
    expect(typeof app.handlers["bebots:bots:list"]).toBe("function");

    const created = await app.handlers["bebots:bots:create"]!(null, {
      name: "IPC Bot",
      persona: "hello",
    });
    expect((created as { name: string }).name).toBe("IPC Bot");

    const list = await app.handlers["bebots:bots:list"]!(null, false);
    expect(Array.isArray(list)).toBe(true);
    expect((list as unknown[]).length).toBe(1);
  });
});
