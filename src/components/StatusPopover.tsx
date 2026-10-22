import type { ReactNode } from "react";
import { Icon } from "./icons";

interface Props {
  /** Accessible name for the region; the visible title is separate. */
  label: string;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  /** Optional controls that belong beside the title, before the close button. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * The shared frame for the status-bar popovers (host resources, transfers,
 * SSH tunnels). One width, header and gutter keeps the three surfaces reading
 * as the same instrument; each popover only owns its body. Kept deliberately
 * free of labels: the title names the surface, and the content explains
 * itself, so no popover repeats its purpose in a subtitle.
 */
export function StatusPopover({
  label,
  title,
  closeLabel,
  onClose,
  actions,
  children,
  className,
}: Props) {
  return (
    <section
      className={className ? `status-popover ${className}` : "status-popover"}
      aria-label={label}
    >
      <header className="status-popover-head">
        <strong className="status-popover-title">{title}</strong>
        {actions && <div className="status-popover-actions">{actions}</div>}
        <button
          type="button"
          className="status-popover-close"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="status-popover-body">{children}</div>
    </section>
  );
}
