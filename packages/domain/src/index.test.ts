import { describe, expect, it } from "vitest";
import {
  asBotId,
  asRunId,
  canTransitionRun,
  canTransitionTask,
  canTransitionApproval,
  isDesktopRenderableForm,
  asFormId,
  encodeAskAnswerMarker,
  parseAskAnswerMarker,
  askAnswerMarkersFromForm,
  appendPromptNotes,
  attachmentPromptNote,
  attachmentRelativePath,
  encodeAttachmentMarker,
  parseAttachmentMarker,
  sanitizeAttachmentFileName,
} from "./index";
import type { Form } from "./index";

describe("asBotId", () => {
  it("accepts a non-empty value", () => {
    expect(asBotId("bot-1")).toBe("bot-1");
  });

  it("rejects an empty value", () => {
    expect(() => asBotId("")).toThrow();
  });

  it("rejects a whitespace-only value", () => {
    expect(() => asBotId("   ")).toThrow();
  });
});

describe("task transitions", () => {
  it("allows queued -> assigned", () => {
    expect(canTransitionTask("queued", "assigned")).toBe(true);
  });

  it("allows running -> awaiting_approval", () => {
    expect(canTransitionTask("running", "awaiting_approval")).toBe(true);
  });

  it("allows awaiting_approval -> running", () => {
    expect(canTransitionTask("awaiting_approval", "running")).toBe(true);
  });

  it("rejects succeeded -> running", () => {
    expect(canTransitionTask("succeeded", "running")).toBe(false);
  });

  it("rejects cancelled -> queued", () => {
    expect(canTransitionTask("cancelled", "queued")).toBe(false);
  });
});

describe("approval transitions", () => {
  it("allows pending -> approved", () => {
    expect(canTransitionApproval("pending", "approved")).toBe(true);
  });

  it("allows pending -> rejected", () => {
    expect(canTransitionApproval("pending", "rejected")).toBe(true);
  });

  it("rejects approved -> pending", () => {
    expect(canTransitionApproval("approved", "pending")).toBe(false);
  });
});

describe("asRunId", () => {
  it("accepts a non-empty value", () => {
    expect(asRunId("run-1")).toBe("run-1");
  });

  it("rejects an empty value", () => {
    expect(() => asRunId("")).toThrow();
  });

  it("rejects a whitespace-only value", () => {
    expect(() => asRunId("   ")).toThrow();
  });
});

describe("run transitions", () => {
  it("allows running -> awaiting_input", () => {
    expect(canTransitionRun("running", "awaiting_input")).toBe(true);
  });

  it("allows awaiting_input -> running", () => {
    expect(canTransitionRun("awaiting_input", "running")).toBe(true);
  });

  it("allows awaiting_input -> cancelled", () => {
    expect(canTransitionRun("awaiting_input", "cancelled")).toBe(true);
  });

  it("rejects awaiting_input -> succeeded", () => {
    expect(canTransitionRun("awaiting_input", "succeeded")).toBe(false);
  });
});

describe("isDesktopRenderableForm", () => {
  const base = {
    id: asFormId("frm_1"),
    sessionId: "ses_1",
    title: "Choose",
  };

  it("accepts string and multiselect fields with custom", () => {
    const form: Form = {
      ...base,
      fields: [
        {
          type: "string",
          key: "q0",
          options: [{ value: "a", label: "A" }],
          custom: true,
        },
        {
          type: "multiselect",
          key: "q1",
          options: [{ value: "b", label: "B" }],
          custom: true,
        },
      ],
    };
    expect(isDesktopRenderableForm(form)).toBe(true);
  });

  it("rejects number and when-gated fields", () => {
    expect(
      isDesktopRenderableForm({
        ...base,
        fields: [{ type: "number", key: "n" }],
      }),
    ).toBe(false);
    expect(
      isDesktopRenderableForm({
        ...base,
        fields: [
          {
            type: "string",
            key: "q0",
            when: [{ key: "other", op: "eq", value: "x" }],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("ask answer markers", () => {
  it("round-trips encode/parse", () => {
    const encoded = encodeAskAnswerMarker("Which package?", "bun");
    expect(parseAskAnswerMarker(encoded)).toEqual({
      kind: "ask-answer",
      question: "Which package?",
      answer: "bun",
    });
  });

  it("ignores unrelated system content", () => {
    expect(parseAskAnswerMarker("Scheduled run triggered")).toBeNull();
    expect(parseAskAnswerMarker("{not json")).toBeNull();
  });

  it("formats option labels from form answers", () => {
    const form: Form = {
      id: asFormId("frm_1"),
      sessionId: "ses_1",
      title: "Questions",
      fields: [
        {
          type: "string",
          key: "q0",
          title: "Package mgr",
          description: "Which package manager?",
          options: [
            { value: "bun", label: "bun" },
            { value: "npm", label: "npm" },
          ],
          custom: true,
        },
      ],
    };
    expect(askAnswerMarkersFromForm(form, { q0: "bun" })).toEqual([
      { kind: "ask-answer", question: "Which package manager?", answer: "bun" },
    ]);
    expect(askAnswerMarkersFromForm(form, { q0: "pnpm" })).toEqual([
      { kind: "ask-answer", question: "Which package manager?", answer: "pnpm" },
    ]);
  });
});

describe("prompt notes", () => {
  it("appends notes below the prompt body", () => {
    expect(appendPromptNotes("hello", ["note-a", "note-b"])).toBe("hello\n\nnote-a\nnote-b");
    expect(appendPromptNotes("", ["only"])).toBe("only");
    expect(appendPromptNotes("keep", [])).toBe("keep");
  });
});

describe("attachment markers", () => {
  it("round-trips encode/parse", () => {
    const encoded = encodeAttachmentMarker({
      fileName: "notes.txt",
      savedName: "notes-1.txt",
      relativePath: attachmentRelativePath("conv-1", "notes-1.txt"),
      size: 12,
      contentType: "text/plain",
      botId: "bot-1",
      conversationId: "conv-1",
    });
    expect(parseAttachmentMarker(encoded)).toEqual({
      kind: "attachment",
      fileName: "notes.txt",
      savedName: "notes-1.txt",
      relativePath: "./receivedFiles/conv-1/notes-1.txt",
      size: 12,
      contentType: "text/plain",
      botId: "bot-1",
      conversationId: "conv-1",
    });
    expect(attachmentPromptNote("./receivedFiles/conv-1/notes-1.txt")).toContain(
      "./receivedFiles/conv-1/notes-1.txt",
    );
  });

  it("sanitizes path-like names", () => {
    expect(sanitizeAttachmentFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentFileName("")).toBe("file");
    expect(parseAttachmentMarker("Scheduled run triggered")).toBeNull();
  });
});
