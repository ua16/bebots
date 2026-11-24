import { ArrowUp, Plus } from "lucide-react";
import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import type { BebotsBot } from "../../shared/preload-api";

interface ComposerProps {
  readonly draft: string;
  readonly placeholder: string;
  readonly inputRef: RefObject<HTMLTextAreaElement>;
  readonly mentionQuery: string | null;
  readonly mentionSuggestions: readonly BebotsBot[];
  readonly mentionIndex: number;
  readonly onSelectMention: (bot: BebotsBot) => void;
  readonly onInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onNewSession: () => void;
  readonly onSubmit: () => void;
  /** When true, sending is blocked (e.g. a reply is already in flight). */
  readonly disabled?: boolean;
}

/** Composer: mention popup, new-session pill, auto-growing textarea, send button. */
export function Composer({
  draft,
  placeholder,
  inputRef,
  mentionQuery,
  mentionSuggestions,
  mentionIndex,
  onSelectMention,
  onInputChange,
  onKeyDown,
  onNewSession,
  onSubmit,
  disabled = false,
}: ComposerProps) {
  return (
    <form
      className={"composer" + (disabled ? " composer-blocked" : "")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      {mentionQuery !== null && mentionSuggestions.length > 0 && (
        <div
          className="mention-popup mention-frame mention-menu"
          role="listbox"
          aria-label="Mention suggestions"
          data-testid="mention-suggestions"
        >
          <ul className="mention-suggestions">
            {mentionSuggestions.map((b, i) => (
              <li key={b.id}>
                <button
                  type="button"
                  className={"mention-option" + (i === mentionIndex ? " highlighted" : "")}
                  aria-selected={i === mentionIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSelectMention(b)}
                >
                  {b.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        className="icon-pill-button"
        aria-label="New session"
        title="New session"
        onClick={onNewSession}
        disabled={disabled}
      >
        <Plus size={24} strokeWidth={2.6} aria-hidden />
      </button>
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        onChange={onInputChange}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="icon-send"
        aria-label="Send"
        title="Send"
        disabled={disabled}
      >
        <ArrowUp size={24} strokeWidth={3} aria-hidden />
      </button>
    </form>
  );
}
