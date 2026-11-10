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
  readonly onSubmit: () => void;
}

/** Composer: mention popup, auto-growing textarea, and send/attach toolbar. */
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
  onSubmit,
}: ComposerProps) {
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
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
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        placeholder={placeholder}
        onChange={onInputChange}
        onKeyDown={onKeyDown}
      />
      <div className="composer-toolbar">
        <button type="submit" className="icon-send" aria-label="Send" title="Send">
          <ArrowUp size={19} strokeWidth={2.4} aria-hidden />
        </button>
        <button
          type="button"
          className="icon-pill-button"
          aria-label="Attach file"
          title="Attach file"
          onClick={() => {}}
        >
          <Plus size={19} strokeWidth={2.1} aria-hidden />
        </button>
      </div>
    </form>
  );
}
