/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UserInputCard,
  answersFromComposerDraft,
  formAllowsComposerAnswer,
} from "./UserInputCard";

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
  it("submits immediately when an option is clicked", () => {
    const onSubmit = vi.fn();
    render(<UserInputCard form={form} onSubmit={onSubmit} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /bun/i }));
    expect(onSubmit).toHaveBeenCalledWith({ q0: "bun" });
  });

  it("does not render an inline custom answer field", () => {
    render(<UserInputCard form={form} onSubmit={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByPlaceholderText("Type your own answer")).toBeNull();
  });
});

describe("answersFromComposerDraft", () => {
  it("maps free text onto the custom field", () => {
    expect(answersFromComposerDraft(form, "  pnpm  ")).toEqual({ q0: "pnpm" });
  });

  it("returns null for blank draft", () => {
    expect(answersFromComposerDraft(form, "   ")).toBeNull();
  });
});

describe("formAllowsComposerAnswer", () => {
  it("is true when custom is allowed", () => {
    expect(formAllowsComposerAnswer(form)).toBe(true);
  });

  it("is false when options are required", () => {
    expect(
      formAllowsComposerAnswer({
        id: "f2",
        title: "Pick",
        fields: [
          {
            key: "q0",
            type: "string",
            options: [{ value: "a", label: "A" }],
          },
        ],
      }),
    ).toBe(false);
  });
});
