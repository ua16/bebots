/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

describe("main entry", () => {
  it("renders the app into #root", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    await import("./main");
    await waitFor(() => {
      expect(root.querySelector("h1")?.textContent).toBe("bebots");
    });
  });

  it("throws when #root is missing", async () => {
    document.body.innerHTML = "";
    vi.resetModules();
    await expect(import("./main")).rejects.toThrow("Root element not found");
  });
});
