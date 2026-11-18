import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  readonly label: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

interface ContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
}

/** Fixed-position popup menu; closes on outside press, Escape, scroll, blur. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const press = (e: MouseEvent) => {
      if (ref.current !== null && e.target instanceof Node && ref.current.contains(e.target)) {
        return;
      }
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", press, true);
    window.addEventListener("contextmenu", press, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", press, true);
      window.removeEventListener("contextmenu", press, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 170);
  const top = Math.min(y, window.innerHeight - items.length * 40 - 16);

  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left, top }}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={"context-menu-item" + (item.danger ? " context-menu-item-danger" : "")}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
