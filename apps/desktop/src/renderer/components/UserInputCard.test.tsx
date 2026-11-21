/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserInputCard } from "./UserInputCard";

afterEach(cleanup);

const form = {
  id: "f1",
  title: "Questions",
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Package mgr",
      description: "Which?",
      custom: true,
      options: [
        { value: "bun", label: "bun", description: "Use Bun" },
        { value: "npm", label: "npm", description: "Use npm" },
      ],
    },
  ],
} as const;

describe("UserInputCard", () => {
  it("selects the first option on click and submits it", () => {
    const onSubmit = vi.fn();
    render(<UserInputCard form={form} onSubmit={onSubmit} onDismiss={() => {}} />);
    const first = screen.getByRole("button", { name: /bun/i });
    fireEvent.click(first);
    expect(first.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ q0: "bun" });
  });

  it("selects the second option on click", () => {
    const onSubmit = vi.fn();
    render(<UserInputCard form={form} onSubmit={onSubmit} onDismiss={() => {}} />);
    const second = screen.getByRole("button", { name: /npm/i });
    fireEvent.click(second);
    expect(second.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ q0: "npm" });
  });
});
