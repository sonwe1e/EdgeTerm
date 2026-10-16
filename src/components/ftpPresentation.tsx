import {
  memo,
  useMemo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { sortFileEntries, toggleFileSort, type SortKey } from "../fileSort";
import { type PaneSide } from "../paneDrop";
import { useStore, type Tab } from "../store";
import type { FileEntry, ThemeMode } from "../types";
import { FileIcon } from "./FileIcon";
import { Icon } from "./icons";
import { SortIndicator } from "./SortIndicator";
import { VirtualFileRows } from "./VirtualFileRows";

/** Pointer travel before a press on a row turns into a drag. */
export const DRAG_THRESHOLD = 5;

export interface Props {
  tab: Tab;
  active: boolean;
}

export interface TransferState {
  direction: "upload" | "download";
  name: string;
  transferred: number;
  total: number;
  status: "running" | "complete" | "error" | "cancelled";
  message?: string;
}

export interface FileBrowserProps {
  title: string;
  subtitle: string;
  path: string;
  draft: string;
  entries: FileEntry[];
  selected: string | null;
  loading: boolean;
  error: string | null;
  actions?: ReactNode;
  side: PaneSide;
  /** The scrolling row list, for the drag's edge auto-scroll; see FtpPane. */
  listRef?: RefObject<HTMLDivElement | null>;
  /** The pointer-drag wiring; see FtpPane's `beginPress` / `dragMove`. */
  onItemPointerDown: (side: PaneSide, entry: FileEntry, event: ReactPointerEvent) => void;
  onItemPointerMove: (event: ReactPointerEvent) => void;
  onItemPointerUp: (event: ReactPointerEvent) => void;
  onDragCancel: () => void;
  /** The row being dragged, so rows can dim it; null when there is none. */
  draggingPath: string | null;
  /** The folder or pane under the pointer, for highlighting. */
  dropHover: { side: PaneSide; dir: string } | null;
  onDraftChange: (value: string) => void;
  onOpenPath: (path: string) => void;
  onHome: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onSelect: (path: string) => void;
  onActivate: (entry: FileEntry) => void;
}

export function FileBrowser({
  title,
  subtitle,
  path,
  draft,
  entries,
  selected,
  loading,
  error,
  actions,
  side,
  listRef,
  onItemPointerDown,
  onItemPointerMove,
  onItemPointerUp,
  onDragCancel,
  draggingPath,
  dropHover,
  onDraftChange,
  onOpenPath,
  onHome,
  onParent,
  onRefresh,
  onSelect,
  onActivate,
}: FileBrowserProps) {
  const theme = useStore((s) => s.theme);
  // One shared choice for both browsers and the Filer panel (see the store's
  // `filerSort`); reading the stored preference once per mount let the two
  // panes drift apart after a change on either side.
  const sort = useStore((s) => s.filerSort);
  const setFilerSort = useStore((s) => s.setFilerSort);
  const sortedEntries = useMemo(() => sortFileEntries(entries, sort), [entries, sort]);

  /** Re-sorts the list for a clicked column caption and remembers the choice. */
  const sortBy = (key: SortKey) => {
    setFilerSort(toggleFileSort(useStore.getState().filerSort, key));
  };

  return (
    <section className="ftp-file-browser">
      <div className="ftp-browser-header">
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="ftp-browser-actions">
          <ToolButton label="Home" onClick={onHome} disabled={loading}>
            <Icon name="home" />
          </ToolButton>
          <ToolButton label="Parent folder" onClick={onParent} disabled={loading || !path}>
            <Icon name="arrow-up" />
          </ToolButton>
          <ToolButton label="Refresh" onClick={onRefresh} disabled={loading}>
            <Icon name="refresh" />
          </ToolButton>
          {actions}
        </div>
      </div>

      <div className="ftp-browser-path">
        <input
          value={draft}
          aria-label={`${title} path`}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onOpenPath(draft);
            if (event.key === "Escape") onDraftChange(path);
          }}
        />
      </div>

      <div className="ftp-browser-columns">
        <button
          type="button"
          className={sort.key === "name" ? "is-sorted" : undefined}
          onClick={() => sortBy("name")}
          aria-label="Sort by name"
        >
          Name
          <SortIndicator sort={sort} column="name" />
        </button>
        <button
          type="button"
          className={sort.key === "size" ? "is-sorted" : undefined}
          onClick={() => sortBy("size")}
          aria-label="Sort by size"
        >
          Size
          <SortIndicator sort={sort} column="size" />
        </button>
        <button
          type="button"
          className={sort.key === "modified" ? "is-sorted" : undefined}
          onClick={() => sortBy("modified")}
          aria-label="Sort by last modified"
        >
          Modified
          <SortIndicator sort={sort} column="modified" />
        </button>
      </div>

      <div
        ref={listRef}
        className={`ftp-browser-list${dropHover != null && dropHover.side === side && dropHover.dir === path ? " is-drop-target" : ""}`}
        data-drop-side={side}
        data-drop-dir={path}
        role="listbox"
        aria-label={`${title} files`}
      >
        {error && <div className="ftp-browser-message is-error">{error}</div>}
        {!error && loading && <div className="ftp-browser-message">Loading…</div>}
        {!error && !loading && entries.length === 0 && (
          <div className="ftp-browser-message">This folder is empty.</div>
        )}
        {!error && (
          <VirtualFileRows
            entries={sortedEntries}
            rowHeight={29}
            resetKey={`${side}:${path}:${sort.key}:${sort.direction}:${!!sort.explicit}`}
          >
            {(entry, index) => (
              <FtpFileRow
                key={entry.path}
                entry={entry}
                position={index + 1}
                total={sortedEntries.length}
                side={side}
                selected={selected === entry.path}
                dragSource={draggingPath === entry.path}
                dropTarget={
                  dropHover != null && dropHover.side === side && dropHover.dir === entry.path
                }
                theme={theme}
                onSelect={onSelect}
                onActivate={onActivate}
                onPointerDown={onItemPointerDown}
                onPointerMove={onItemPointerMove}
                onPointerUp={onItemPointerUp}
                onDragCancel={onDragCancel}
              />
            )}
          </VirtualFileRows>
        )}
      </div>
      <div className="ftp-browser-footer">
        <span>{entries.length} items</span>
        <span>{loading ? "Loading…" : path}</span>
      </div>
    </section>
  );
}

/**
 * One row of a browser pane, memoised so a re-render that nothing on the row
 * depends on — a transfer tick, a hover elsewhere, a selection in the other
 * pane — skips every row instead of rebuilding its JSX, size and date
 * strings. Only primitive props and stable callbacks cross this boundary
 * (see useStableCallback); the drag/drop flags arrive as booleans so a
 * hover change re-renders at most the one row it moved to.
 */
export const FtpFileRow = memo(function FtpFileRow({
  entry,
  position,
  total,
  side,
  selected,
  dragSource,
  dropTarget,
  theme,
  onSelect,
  onActivate,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDragCancel,
}: {
  entry: FileEntry;
  position: number;
  total: number;
  side: PaneSide;
  selected: boolean;
  dragSource: boolean;
  dropTarget: boolean;
  theme: ThemeMode;
  onSelect: (path: string) => void;
  onActivate: (entry: FileEntry) => void;
  onPointerDown: (side: PaneSide, entry: FileEntry, event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onDragCancel: () => void;
}) {
  return (
    <div
      className={`ftp-file-row${selected ? " is-selected" : ""}${entry.isDir ? " is-directory" : ""}${dragSource ? " is-drag-source" : ""}${dropTarget ? " is-drop-target" : ""}`}
      role="option"
      aria-posinset={position}
      aria-setsize={total}
      aria-selected={selected}
      data-drop-side={entry.isDir ? side : undefined}
      data-drop-dir={entry.isDir ? entry.path : undefined}
      onPointerDown={(event) => onPointerDown(side, entry, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onDragCancel}
      onClick={() => onSelect(entry.path)}
      onDoubleClick={() => onActivate(entry)}
      title={entry.path}
    >
      <span className="ftp-file-name">
        <span className="ftp-file-icon" aria-hidden="true">
          <FileIcon name={entry.name} isDir={entry.isDir} theme={theme} />
        </span>
        <span>{entry.name}</span>
      </span>
      <span>{entry.isDir ? "—" : formatBytes(entry.size)}</span>
      <span>{formatDate(entry.modified)}</span>
    </div>
  );
});

export function ToolButton({
  label,
  children,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`ftp-tool-button${danger ? " is-danger" : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function remoteParent(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

export function joinRemote(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base.replace(/\/+$/, "")}/${name}`;
}

export function joinLocal(base: string, name: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? "0 B" : "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

// One formatter for every row's date: `toLocaleString` with options builds
// an Intl.DateTimeFormat per call, and a thousand-row list re-renders its
// dates often enough for that to show. `toLocaleString` is specified as
// exactly this constructor plus `format`, so the output is identical.
export const ROW_DATE = new Intl.DateTimeFormat([], {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(seconds: number | null): string {
  if (seconds == null) return "—";
  return ROW_DATE.format(new Date(seconds * 1000));
}

export function friendlyFtpError(error: unknown): string {
  const message = String(error);
  if (message.includes("Response contains an invalid syntax")) {
    return "The FTP server returned a legacy or non-UTF-8 directory listing. Reconnect after updating EdgeTerm and try again.";
  }
  return message;
}
