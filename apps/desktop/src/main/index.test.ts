import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("main entry", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
  });

  afterEach(() => {
    delete process.env.ELECTRON_RENDERER_URL;
    vi.restoreAllMocks();
  });

  it("initializes, applies CSP, and uses the dev server URL", async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const show = vi.fn();
    const onWindow = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb;
    });
    const loadURL = vi.fn();
    const loadFile = vi.fn();
    const BrowserWindow = vi.fn().mockImplementation(() => ({
      on: onWindow,
      loadURL,
      loadFile,
      show,
    }));
    (BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows = vi.fn(
      () => [],
    );

    let cspCallback: ((details: unknown, cb: (res: unknown) => void) => void) | undefined;
    const onHeadersReceived = vi.fn(
      (cb: (details: unknown, cb2: (res: unknown) => void) => void) => {
        cspCallback = cb;
      },
    );

    vi.doMock("electron", () => ({
      app: {
        isPackaged: false,
        whenReady: vi.fn(() => Promise.resolve()),
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb;
        }),
        quit: vi.fn(),
      },
      BrowserWindow,
      session: { defaultSession: { webRequest: { onHeadersReceived } } },
    }));

    await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // invoke CSP callback
    const cb = vi.fn();
    cspCallback?.({ responseHeaders: {} }, cb);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ responseHeaders: expect.any(Object) }),
    );

    const bwInstance = (
      BrowserWindow as unknown as { mock: { results: Array<{ value: unknown }> } }
    ).mock.results[0]!.value as {
      loadURL: ReturnType<typeof vi.fn>;
    };
    expect(bwInstance.loadURL).toHaveBeenCalled();
    handlers["ready-to-show"]?.();
    expect(show).toHaveBeenCalled();
    // activate with no windows recreates
    handlers["activate"]?.();
    expect(BrowserWindow).toHaveBeenCalledTimes(2);
  });

  it("loads the file in production mode", async () => {
    vi.doMock("electron", () => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const BrowserWindow = vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        show: vi.fn(),
      }));
      (BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows = vi.fn(
        () => [],
      );
      return {
        app: {
          isPackaged: true,
          whenReady: vi.fn(() => Promise.resolve()),
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            handlers[event] = cb;
          }),
          quit: vi.fn(),
        },
        BrowserWindow,
        session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
      };
    });

    delete process.env.ELECTRON_RENDERER_URL;
    await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const electron = await import("electron");
    expect(electron.app.on as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("handles whenReady rejection", async () => {
    vi.doMock("electron", () => ({
      app: {
        isPackaged: false,
        whenReady: vi.fn(() => Promise.reject(new Error("boom"))),
        on: vi.fn(),
        quit: vi.fn(),
      },
      BrowserWindow: vi.fn(),
      session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    }));

    await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const electron = await import("electron");
    expect(electron.app.quit as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("quits on window-all-closed on non-darwin", async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const quit = vi.fn();
    vi.doMock("electron", () => {
      const BrowserWindow = vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        show: vi.fn(),
      }));
      (BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows = vi.fn(
        () => [],
      );
      return {
        app: {
          isPackaged: false,
          whenReady: vi.fn(() => Promise.resolve()),
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            handlers[event] = cb;
          }),
          quit,
        },
        BrowserWindow,
        session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
      };
    });

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 10));
    handlers["window-all-closed"]?.();
    expect(quit).toHaveBeenCalled();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("does not quit on window-all-closed on darwin", async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const quit = vi.fn();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.doMock("electron", () => {
      const BrowserWindow = vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        show: vi.fn(),
      }));
      (BrowserWindow as unknown as { getAllWindows: () => unknown[] }).getAllWindows = vi.fn(
        () => [],
      );
      return {
        app: {
          isPackaged: false,
          whenReady: vi.fn(() => Promise.resolve()),
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            handlers[event] = cb;
          }),
          quit,
        },
        BrowserWindow,
        session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
      };
    });

    await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 10));
    handlers["window-all-closed"]?.();
    expect(quit).not.toHaveBeenCalled();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("applies the strict CSP in production mode", async () => {
    let cspCallback: ((details: unknown, cb: (res: unknown) => void) => void) | undefined;
    const onHeadersReceived = vi.fn(
      (cb: (details: unknown, cb2: (res: unknown) => void) => void) => {
        cspCallback = cb;
      },
    );
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
        isPackaged: true,
        whenReady: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        quit: vi.fn(),
      },
      BrowserWindow,
      session: { defaultSession: { webRequest: { onHeadersReceived } } },
    }));

    delete process.env.ELECTRON_RENDERER_URL;
    await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cb = vi.fn();
    cspCallback?.({ responseHeaders: {} }, cb);
    const result = cb.mock.calls[0]![0] as {
      responseHeaders: Record<string, string[]>;
    };
    const csp = result.responseHeaders["Content-Security-Policy"]![0]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
  });
});
