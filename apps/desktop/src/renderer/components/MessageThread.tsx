import type { JSX, RefObject } from "react";
import type { BebotsBot } from "../../shared/preload-api";
import type { ApiMessage } from "../lib/api-types";
import { BotAvatar } from "./avatar";
import { botName } from "../lib/bot-name";

interface MessageThreadProps {
  readonly messages: readonly ApiMessage[];
  readonly hasActiveConversation: boolean;
  readonly bots: readonly BebotsBot[];
  readonly pendingReply: boolean;
  readonly typingLabel: string;
  readonly threadNotice: string | null;
  readonly emptyHintBotName: string;
  readonly endRef: RefObject<HTMLDivElement>;
}

/**
 * Renders a mention-bearing message body: `@bot-id` fragments resolve to the
 * bot's display name; unknown tokens stay as plain text.
 */
export function renderMentionContent(
  content: string,
  bots: readonly BebotsBot[],
): Array<JSX.Element> {
  const parts = content.split(/(@[A-Za-z0-9_-]+)/g);
  return parts.map((part, index) => {
    const match = part.match(/^@([A-Za-z0-9_-]+)$/);
    if (match) {
      const mentioned = bots.find((b) => b.id === match[1]);
      if (mentioned) {
        return (
          <span key={index} className="mention">
            @<span className="mention-name">{mentioned.name}</span>
          </span>
        );
      }
    }
    return <span key={index}>{part}</span>;
  });
}

/** The message list for the open conversation, with typing/notice states. */
export function MessageThread({
  messages,
  hasActiveConversation,
  bots,
  pendingReply,
  typingLabel,
  threadNotice,
  emptyHintBotName,
  endRef,
}: MessageThreadProps) {
  return (
    <div className="chat-thread">
      {hasActiveConversation &&
        messages.map((m) =>
          m.senderType === "system" ? (
            <div key={m.id} className="message message-system">
              <span className="message-content">{m.content}</span>
              <time className="message-time">
                {new Date(m.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
          ) : (
            <div
              key={m.id}
              className={`message ${m.senderType === "human" ? "message-human" : "message-bot"}`}
            >
              {m.senderType === "bot" ? (
                <span className="message-identity">
                  <BotAvatar id={m.senderId} size={18} />
                  <span className="message-sender">{botName(bots, m.senderId)}</span>
                </span>
              ) : (
                <span className="message-identity">
                  <span className="message-sender">You</span>
                </span>
              )}
              <span className="message-content">{renderMentionContent(m.content, bots)}</span>
              <time className="message-time">
                {new Date(m.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
          ),
        )}
      {hasActiveConversation && pendingReply && <div className="typing">{typingLabel}</div>}
      {threadNotice !== null && <div className="thread-notice">{threadNotice}</div>}
      {!hasActiveConversation && (
        <p className="thread-empty-hint">
          No session selected — say hello to start one with {emptyHintBotName}.
        </p>
      )}
      <div ref={endRef} />
    </div>
  );
}
