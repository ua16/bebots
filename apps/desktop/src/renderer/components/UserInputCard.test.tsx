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
  it("submits immediately when the first option is clicked", () => {
    const onSubmit = vi.fn();
    render(<UserInputCard form={form} onSubmit={onSubmit} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /bun/i }));
    expect(onSubmit).toHaveBeenCalledWith({ q0: "bun" });
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("submits immediately when the second option is clicked", () => {
    const onSubmit = vi.fn();
    render(<UserInputCard form={form} onSubmit={onSubmit} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /npm/i }));
    expect(onSubmit).toHaveBeenCalledWith({ q0: "npm" });
  });

  it("submits a custom answer on Enter", () => {
    const onSubmit = vi.fn();
    render(<UserInputCard form={form} onSubmit={onSubmit} onDismiss={() => {}} />);
    const input = screen.getByPlaceholderText("Type your own answer");
    fireEvent.change(input, { target: { value: "pnpm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ q0: "pnpm" });
  });
});
