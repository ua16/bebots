/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createRef } from "react";
import { encodeAskAnswerMarker } from "@bebots/domain";
import { MessageThread } from "./MessageThread";

afterEach(cleanup);

describe("MessageThread ask markers", () => {
  it("renders ask-answer system content as a subtle Q&A marker", () => {
    render(
      <MessageThread
        messages={[
          {
            id: "m1",
            conversationId: "c1",
            senderType: "system",
            content: encodeAskAnswerMarker("Which package manager?", "bun"),
            createdAt: 1,
          },
        ]}
        hasActiveConversation
        bots={[]}
        pendingReply={false}
        typingLabel=""
        threadNotice={null}
        emptyHintBotName="Bot"
        endRef={createRef()}
      />,
    );
    const marker = screen.getByTestId("ask-answer-marker");
    expect(marker.textContent).toContain("Which package manager?");
    expect(marker.textContent).toContain("bun");
    expect(marker.querySelector(".ask-marker-answer")?.tagName).toBe("STRONG");
  });

  it("keeps plain system markers as schedule-style messages", () => {
    render(
      <MessageThread
        messages={[
          {
            id: "m1",
            conversationId: "c1",
            senderType: "system",
            content: "Scheduled run triggered",
            createdAt: 1,
          },
        ]}
        hasActiveConversation
        bots={[]}
        pendingReply={false}
        typingLabel=""
        threadNotice={null}
        emptyHintBotName="Bot"
        endRef={createRef()}
      />,
    );
    expect(screen.queryByTestId("ask-answer-marker")).toBeNull();
    expect(screen.getByText("Scheduled run triggered")).toBeTruthy();
  });
});
