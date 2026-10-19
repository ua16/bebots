import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("main IPC", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bebots-main-"));
    vi.resetModules();
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
  });

  afterEach(() => {
    delete process.env.ELECTRON_RENDERER_URL;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers bot handlers and runs effects", async () => {
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    const ipcMain = {
      handle: vi.fn((channel: string, cb: (...args: unknown[]) => unknown) => {
        handlers[channel] = cb as (...args: unknown[]) => Promise<unknown>;
      }),
    };
    const BrowserWindow = vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      show: vi.fn(),
    }));
    (BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows = vi.fn(
      () => [],
    );

    vi.doMock("electron", () => ({
      app: {
        isPackaged: false,
        getPath: vi.fn(() => dir),
        whenReady: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        quit: vi.fn(),
      },
      BrowserWindow,
      ipcMain,
      session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    }));

    await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ipcMain.handle).toHaveBeenCalledWith("bebots:bots:list", expect.any(Function));
    expect(typeof handlers["bebots:bots:list"]).toBe("function");

    const created = await handlers["bebots:bots:create"]!(null, {
      name: "IPC Bot",
      persona: "hello",
    });
    expect((created as { name: string }).name).toBe("IPC Bot");

    const list = await handlers["bebots:bots:list"]!(null, false);
    expect(Array.isArray(list)).toBe(true);
    expect((list as unknown[]).length).toBe(1);
  });
});
