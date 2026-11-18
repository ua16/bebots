import { useEffect, useId, useRef, type ReactNode } from "react";

interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly children?: ReactNode;
  readonly onClose: () => void;
}

/** Modal dialog: blurs and dims the rest of the UI; Escape / backdrop dismiss. */
export function Dialog({ open, title, children, onClose }: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", key, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {children}
      </section>
    </div>
  );
}
