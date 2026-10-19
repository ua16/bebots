/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

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
});
