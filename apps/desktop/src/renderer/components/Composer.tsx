import { ArrowUp, FileIcon, Paperclip, Plus, X } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, RefObject } from "react";
import { useRef } from "react";
import type { BebotsBot } from "../../shared/preload-api";
import { formatFileSize, type StagedAttachment } from "../lib/attachments";

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
  readonly inputDisabled?: boolean;
  readonly sendDisabled?: boolean;
  readonly stagedFiles?: readonly StagedAttachment[];
  readonly onAddFiles?: ((files: readonly File[]) => void) | undefined;
  readonly onRemoveFile?: ((id: string) => void) | undefined;
  readonly stagingLocked?: boolean;
}

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
  inputDisabled = false,
  sendDisabled = false,
  stagedFiles = [],
  onAddFiles,
  onRemoveFile,
  stagingLocked = false,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canAttach = onAddFiles !== undefined && !inputDisabled;

  const takeFiles = (list: FileList | readonly File[] | null | undefined) => {
    if (!onAddFiles || !list) return;
    const files = [...list].filter((f) => f instanceof File);
    if (files.length > 0) onAddFiles(files);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    takeFiles(files);
  };

  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canAttach) return;
    takeFiles(e.dataTransfer?.files);
  };

  const canSubmit =
    !sendDisabled && (draft.trim().length > 0 || stagedFiles.length > 0) && !inputDisabled;

  return (
    <form
      className={"composer" + (sendDisabled || inputDisabled ? " composer-blocked" : "")}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
      onDragOver={(e) => {
        if (!canAttach) return;
        e.preventDefault();
      }}
      onDrop={onDrop}
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
      {stagedFiles.length > 0 && (
        <div className="composer-attachments" data-testid="composer-attachments">
          {stagedFiles.map((item) => (
            <div
              key={item.id}
              className="composer-attachment-chip"
              data-testid="composer-attachment-chip"
            >
              <FileIcon size={14} strokeWidth={2} aria-hidden />
              <span className="composer-attachment-name" title={item.file.name}>
                {item.file.name}
              </span>
              <span className="composer-attachment-size">{formatFileSize(item.file.size)}</span>
              {item.progress !== null && (
                <span
                  className="composer-attachment-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(item.progress * 100)}
                >
                  <span
                    className="composer-attachment-progress-bar"
                    style={{ width: `${Math.round(item.progress * 100)}%` }}
                  />
                </span>
              )}
              {onRemoveFile && !stagingLocked && (
                <button
                  type="button"
                  className="composer-attachment-remove"
                  aria-label={`Remove ${item.file.name}`}
                  onClick={() => onRemoveFile(item.id)}
                >
                  <X size={14} strokeWidth={2.4} aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <button
          type="button"
          className="icon-pill-button"
          aria-label="New session"
          title="New session"
          onClick={onNewSession}
          disabled={inputDisabled}
        >
          <Plus size={24} strokeWidth={2.6} aria-hidden />
        </button>
        {canAttach && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="composer-file-input"
              data-testid="composer-file-input"
              onChange={(e) => {
                takeFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="icon-pill-button"
              aria-label="Attach files"
              title="Attach files"
              disabled={inputDisabled}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={22} strokeWidth={2.4} aria-hidden />
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          placeholder={placeholder}
          disabled={inputDisabled}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          type="submit"
          className="icon-send"
          aria-label="Send"
          title="Send"
          disabled={!canSubmit}
        >
          <ArrowUp size={24} strokeWidth={3} aria-hidden />
        </button>
      </div>
    </form>
  );
}
