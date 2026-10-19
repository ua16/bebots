/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BebotsPreloadApi } from "../shared/preload-api";
import { App } from "./App";

const bot = {
  id: "b1",
  homePath: "/tmp/bots/b1",
  name: "Bot One",
  description: "desc",
  persona: "persona",
  status: "active" as const,
  createdAt: 1,
  updatedAt: 1,
};

function installApi(overrides: Partial<BebotsPreloadApi> = {}): BebotsPreloadApi {
  const api = {
    platform: "darwin",
    versions: { electron: "33", chrome: "130" },
    workspace: { getRoot: vi.fn(async () => "/tmp/bots") },
    bots: {
      list: vi.fn(async () => [bot]),
      get: vi.fn(async () => bot),
      create: vi.fn(async () => bot),
      update: vi.fn(async () => bot),
      archive: vi.fn(async () => bot),
    },
    runs: {
      start: vi.fn(async () => ({
        id: "r1",
        botId: "b1",
        triggerType: "manual",
        prompt: "do it",
        status: "running",
        timeoutMs: 1,
        createdAt: 1,
        updatedAt: 1,
      })),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      cancel: vi.fn(async () => null),
      events: vi.fn(async () => []),
      await: vi.fn(async () => ({
        id: "r1",
        botId: "b1",
        triggerType: "manual",
        prompt: "do it",
        status: "succeeded",
        timeoutMs: 1,
        summary: "all done",
        createdAt: 1,
        updatedAt: 2,
      })),
    },
    ...overrides,
  } as unknown as BebotsPreloadApi;
  (window as unknown as { bebots?: unknown }).bebots = api;
  return api;
}

describe("App", () => {
  beforeEach(() => {
    delete (window as unknown as { bebots?: unknown }).bebots;
  });
  afterEach(() => cleanup());

  it("renders the product title and tagline", () => {
    render(<App />);
    expect(screen.getByText("bebots")).toBeTruthy();
    expect(screen.getByText("Local-first multi-bot agent hub")).toBeTruthy();
  });

  it("shows unavailable when the preload bridge is missing", () => {
    render(<App />);
    expect(screen.getByText("Platform: unavailable")).toBeTruthy();
  });

  it("shows the platform from the preload bridge", () => {
    (
      window as unknown as {
        bebots: { platform: string; versions: { electron: string; chrome: string } };
      }
    ).bebots = {
      platform: "darwin",
      versions: { electron: "33", chrome: "130" },
    };
    render(<App />);
    expect(screen.getByText("Platform: darwin")).toBeTruthy();
    delete (window as unknown as { bebots?: unknown }).bebots;
  });

  it("shows the workspace root and runs a bot", async () => {
    const api = installApi();
    render(<App />);

    expect(await screen.findByText("Bots home: /tmp/bots")).toBeTruthy();

    fireEvent.click(await screen.findByText("Bot One"));

    const prompt = await screen.findByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "do it" } });
    fireEvent.click(screen.getByText("Run"));

    expect(await screen.findByText("Run: succeeded")).toBeTruthy();
    expect(screen.getByText("all done")).toBeTruthy();
    expect(api.runs.start).toHaveBeenCalledWith({ botId: "b1", prompt: "do it" });
    expect(api.runs.await).toHaveBeenCalledWith("r1", 120000);
  });

  it("surfaces run failures", async () => {
    const api = installApi();
    (api.runs.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    render(<App />);

    fireEvent.click(await screen.findByText("Bot One"));
    fireEvent.click(await screen.findByText("Run"));

    expect(await screen.findByText("Run: failed")).toBeTruthy();
    expect(screen.getByText("Error: boom")).toBeTruthy();
  });

  it("tolerates a workspace root lookup failure", async () => {
    installApi({
      workspace: { getRoot: vi.fn(async () => Promise.reject(new Error("nope"))) },
    });
    render(<App />);
    expect(await screen.findByText("Bot One")).toBeTruthy();
  });
});
