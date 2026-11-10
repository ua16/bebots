import { useCallback, useState } from "react";
import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import type { BebotsBot } from "../../shared/preload-api";

interface UseMentionsOptions {
  /** Full composer draft text; updated by the same `onChange` that drives mentions. */
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly bots: readonly BebotsBot[];
  readonly inputRef: RefObject<HTMLTextAreaElement>;
  /** Called when the user presses Enter (without Shift) to send. */
  readonly onSend: () => void;
}

/**
 * The "@" mention machinery for the composer: detections from draft edits,
 * keyboard navigation of the suggestion popup, and completion that rewrites
 * the draft. State was lifted out of App.tsx unchanged.
 */
export function useMentions({ draft, setDraft, bots, inputRef, onSend }: UseMentionsOptions) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const mentionSuggestions =
    mentionQuery === null
      ? []
      : bots.filter(
          (b) =>
            b.name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
            b.id.toLowerCase().includes(mentionQuery.toLowerCase()),
        );

  const clearMentions = useCallback(() => {
    setMentionQuery(null);
    setMentionStart(null);
    setMentionIndex(0);
  }, []);

  const selectMention = useCallback(
    (bot: BebotsBot) => {
      if (mentionStart === null || mentionQuery === null) return;
      const before = draft.slice(0, mentionStart);
      const after = draft.slice(mentionStart + 1 + mentionQuery.length);
      setDraft(`${before}@${bot.id} ${after}`);
      clearMentions();
      inputRef.current?.focus();
    },
    [draft, mentionQuery, mentionStart, setDraft, clearMentions, inputRef],
  );

  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDraft(value);
    const caret = e.target.selectionStart ?? value.length;
    const idx = value.lastIndexOf("@", caret - 1);
    if (idx !== -1) {
      const between = value.slice(idx + 1, caret);
      if (!/\s/.test(between)) {
        if (idx === 0 || /\s/.test(value[idx - 1] ?? "")) {
          setMentionQuery(between);
          setMentionStart(idx);
          setMentionIndex(0);
        } else {
          setMentionQuery(null);
          setMentionStart(null);
        }
      } else {
        setMentionQuery(null);
        setMentionStart(null);
      }
    } else {
      setMentionQuery(null);
      setMentionStart(null);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const chosen = mentionSuggestions[mentionIndex] ?? mentionSuggestions[0];
        if (chosen) selectMention(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        setMentionStart(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return {
    mentionQuery,
    mentionSuggestions,
    mentionIndex,
    clearMentions,
    handleInputChange,
    handleKeyDown,
    selectMention,
  };
}
