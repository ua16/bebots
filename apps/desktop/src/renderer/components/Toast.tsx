import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export interface ToastItem {
  readonly id: string;
  readonly message: string;
  readonly tone?: "error" | "info";
}

interface ToastStackProps {
  readonly toasts: readonly ToastItem[];
  readonly durationMs?: number;
  readonly onDismiss: (id: string) => void;
}

interface ToastProps {
  readonly id: string;
  readonly message: string;
  readonly tone?: "error" | "info";
  readonly durationMs: number;
  readonly onDismiss: (id: string) => void;
}

function Toast({ id, message, tone = "error", durationMs, onDismiss }: ToastProps) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(id), durationMs);
    return () => window.clearTimeout(timer);
  }, [id, durationMs]);

  return (
    <div className={`toast toast-${tone}`} role="status">
      <span className="toast-message">{message}</span>
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss"
        onClick={() => onDismiss(id)}
      >
        <X size={16} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

export function ToastStack({ toasts, durationMs = 30_000, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          id={toast.id}
          message={toast.message}
          tone={toast.tone ?? "error"}
          durationMs={durationMs}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
