import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { errorText } from "../errorInfo";
import {
  clickMode,
  selectEntry,
  selectForMenu,
  selectedEntries,
  type FileSelection,
  type SelectMode,
} from "../fileBatch";
import { sortFileEntries, toggleFileSort, type SortKey } from "../fileSort";
import { type PaneSide } from "../paneDrop";
import { IS_MAC } from "../platform";
import { useStore, type Tab } from "../store";
import { t as translateMsg } from "../i18n";
import { useStableCallback } from "../useStableCallback";
import { useT } from "../useT";
import type { FileEntry, ThemeMode } from "../types";
import { FileIcon } from "./FileIcon";
import { Icon } from "./icons";
import { SortIndicator } from "./SortIndicator";
import { useFileListKeyboard } from "./useFileListKeyboard";
import { VirtualFileRows } from "./VirtualFileRows";

/** Pointer travel before a press on a row turns into a drag. */
export const DRAG_THRESHOLD = 5;

/**
 * Stable id of a rendered option, so the listbox can point
 * `aria-activedescendant` at it. A path may hold spaces or slashes, which
 * are not allowed in an id, so it is percent-encoded; the side keeps the
 * two panes' ids apart inside one document.
 */
const ftpOptionId = (side: PaneSide, path: string): string =>
  `ftp-option-${side}-${encodeURIComponent(path)}`;

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
  /** The pane's whole selection, not just the row the cursor is on. */
  selection: FileSelection;
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
  onSelectionChange: (selection: FileSelection) => void;
  /**
   * A right click on a row, after the selection the menu acts on has been
   * applied; `targets` is that selection in listing order.
   */
  onRowMenu?: (
    side: PaneSide,
    entry: FileEntry,
    targets: readonly FileEntry[],
    at: { x: number; y: number },
  ) => void;
  onActivate: (entry: FileEntry) => void;
}

export function FileBrowser({
  title,
  subtitle,
  path,
  draft,
  entries,
  selection,
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
  onSelectionChange,
  onRowMenu,
  onActivate,
}: FileBrowserProps) {
  const t = useT();
  const theme = useStore((s) => s.theme);
  // One shared choice for both browsers and the Filer panel (see the store's
  // `filerSort`); reading the stored preference once per mount let the two
  // panes drift apart after a change on either side.
  const sort = useStore((s) => s.filerSort);
  const setFilerSort = useStore((s) => s.setFilerSort);
  const sortedEntries = useMemo(() => sortFileEntries(entries, sort), [entries, sort]);
  // The listing as shown, which is what a Shift-click range spans.
  const order = useMemo(() => sortedEntries.map((entry) => entry.path), [sortedEntries]);

  // The keyboard model of the list: one Tab stop on the listbox, a cursor
  // announced through aria-activedescendant, selection following the
  // cursor. Mirrors the Filer panel's list (see useFileListKeyboard).
  const optionId = useCallback(
    (path: string) => ftpOptionId(side, path),
    [side],
  );
  const { activeDescendant, onKeyDown, onRowSelect } = useFileListKeyboard({
    entries: sortedEntries,
    rowHeight: 29,
    listRef,
    optionId,
    // The cursor and a pointer press both change the pane's selection; the
    // modifier state arrives as a mode, so Ctrl toggles and Shift extends.
    onSelect: (path, mode: SelectMode) =>
      onSelectionChange(selectEntry(selection, order, path, mode)),
    onActivate,
    // Typing a name jumps to it (upstream issue #108). An error replaces the
    // rows but keeps the listing they came from, so there is nothing on
    // screen for a typed name to land on.
    typeSelect: !error,
  });

  /**
   * A right click acts on the whole selection it lands in: a row that is
   * already selected keeps the selection, anything else becomes a selection
   * of its own. The menu receives the entries it will act on, so it never
   * reads a selection that has not landed yet.
   */
  const rowMenu = useStableCallback((entry: FileEntry, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const next = selectForMenu(selection, entry.path);
    if (next !== selection) onSelectionChange(next);
    onRowMenu?.(side, entry, selectedEntries(sortedEntries, next), {
      x: event.clientX,
      y: event.clientY,
    });
  });

  const columnsRef = useRef<HTMLDivElement>(null);
  // The caption row is a sibling of the scroll container, not a child of it,
  // so nothing tells it how wide the list's scrollbar is and its columns sat
  // a scrollbar to the right of the ones they named. Measured rather than
  // assumed: the width is a platform decision, and it is 0 where the platform
  // draws overlay scrollbars — there is nothing to compensate for there.
  // Watched with an observer rather than on window resize, because everything
  // that can change it is not the window: the pane splitter, a font-size
  // change, the listing itself growing past the fold. Deps are what
  // VirtualFileRows re-measures on for the same reason; the observer covers
  // the rest. Mirrors FilerPanel's own caption row (see there).
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable scroller ref, listing length is the signal
  useLayoutEffect(() => {
    const list = listRef?.current;
    const columns = columnsRef.current;
    if (!list || !columns) return;
    let seen = "";
    const measure = () => {
      const next = `${Math.max(0, list.offsetWidth - list.clientWidth)}px`;
      if (next === seen) return;
      seen = next;
      columns.style.setProperty("--ftp-sb-w", next);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(list);
    measure();
    return () => resize.disconnect();
  }, [entries.length]);

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
          <ToolButton label={t("filer.home")} onClick={onHome} disabled={loading}>
            <Icon name="home" />
          </ToolButton>
          <ToolButton label={t("filer.parentFolder")} onClick={onParent} disabled={loading || !path}>
            <Icon name="arrow-up" />
          </ToolButton>
          <ToolButton label={t("filer.refresh")} onClick={onRefresh} disabled={loading}>
            <Icon name="refresh" />
          </ToolButton>
          {actions}
        </div>
      </div>

      <div className="ftp-browser-path">
        <input
          value={draft}
          aria-label={t("ftp.pathAria", { title })}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onOpenPath(draft);
            if (event.key === "Escape") onDraftChange(path);
          }}
        />
      </div>

      {/* Sortable captions, mirroring the Filer panel's: no `aria-label`
          here, because replacing the visible text with an instruction made a
          screen reader announce the verb ("sort by size") and never the
          column's own name ("Size"). The visible text is the accessible
          name, `aria-sort` carries which column is sorted and in which
          direction (the arrow says it by sight alone), and the sr-only line
          says what a click will do. `data-sort-key` is the stable handle a
          caller selects a caption by, the way FilerPanel's captions carry. */}
      <div className="ftp-browser-columns" ref={columnsRef}>
        <button
          type="button"
          className={sort.key === "name" ? "is-sorted" : undefined}
          data-sort-key="name"
          onClick={() => sortBy("name")}
          aria-sort={
            sort.key === "name" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
          }
        >
          {t("session.name")}
          <SortIndicator sort={sort} column="name" />
          <span className="sr-only">{t("filer.sortByName")}</span>
        </button>
        <button
          type="button"
          className={sort.key === "size" ? "is-sorted" : undefined}
          data-sort-key="size"
          onClick={() => sortBy("size")}
          aria-sort={
            sort.key === "size" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
          }
        >
          {t("filer.size")}
          <SortIndicator sort={sort} column="size" />
          <span className="sr-only">{t("filer.sortBySize")}</span>
        </button>
        <button
          type="button"
          className={sort.key === "modified" ? "is-sorted" : undefined}
          data-sort-key="modified"
          onClick={() => sortBy("modified")}
          aria-sort={
            sort.key === "modified"
              ? sort.direction === "asc"
                ? "ascending"
                : "descending"
              : "none"
          }
        >
          {t("filer.modified")}
          <SortIndicator sort={sort} column="modified" />
          <span className="sr-only">{t("filer.sortByModified")}</span>
        </button>
      </div>

      <div
        ref={listRef}
        className={`ftp-browser-list${dropHover != null && dropHover.side === side && dropHover.dir === path ? " is-drop-target" : ""}`}
        data-drop-side={side}
        data-drop-dir={path}
        role="listbox"
        aria-label={t("ftp.filesAria", { title })}
        tabIndex={0}
        aria-activedescendant={activeDescendant ?? undefined}
        onKeyDown={onKeyDown}
      >
        {error && <div className="ftp-browser-message is-error">{error}</div>}
        {!error && loading && <div className="ftp-browser-message">{t("ftp.loading")}</div>}
        {!error && !loading && entries.length === 0 && (
          <div className="ftp-browser-message">{t("ftp.emptyFolder")}</div>
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
                selected={selection.paths.includes(entry.path)}
                dragSource={draggingPath === entry.path}
                dropTarget={
                  dropHover != null && dropHover.side === side && dropHover.dir === entry.path
                }
                theme={theme}
                onSelect={onRowSelect}
                onContextMenu={rowMenu}
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
        <span>
          {t("ftp.items", { count: entries.length })}
          {selection.paths.length > 1 &&
            ` · ${t("filer.selectedCount", { count: selection.paths.length })}`}
        </span>
        <span>{loading ? t("ftp.loading") : path}</span>
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
  onContextMenu,
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
  /** A primary press: `mode` is what its modifiers mean (see `clickMode`). */
  onSelect: (path: string, mode?: SelectMode) => void;
  onContextMenu: (entry: FileEntry, event: ReactMouseEvent) => void;
  onActivate: (entry: FileEntry) => void;
  onPointerDown: (side: PaneSide, entry: FileEntry, event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onDragCancel: () => void;
}) {
  return (
    <div
      id={ftpOptionId(side, entry.path)}
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
      onClick={(event) => {
        // The context menu's own press must not collapse the selection it is
        // about to act on; clickMode answers null for it (and for right clicks).
        const mode = clickMode(event, IS_MAC);
        if (mode) onSelect(entry.path, mode);
      }}
      onDoubleClick={() => onActivate(entry)}
      onContextMenu={(event) => onContextMenu(entry, event)}
      title={entry.path}
    >
      <span className="ftp-file-name">
        <span className="ftp-file-icon" aria-hidden="true">
          <FileIcon name={entry.name} isDir={entry.isDir} theme={theme} />
        </span>
        <span>{entry.name}</span>
      </span>
      {/* A folder has no size of its own: an empty cell, the way the Filer
          panel's rows show it, so the two browsers read the column alike. */}
      <span>{entry.isDir ? "" : formatBytes(entry.size)}</span>
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

// A listing that withheld the moment says "unknown" in words, the same word
// the Filer panel's column uses: a dash means "no value the way a folder has
// none", and a time that was asked for and not given is not that.
export function formatDate(seconds: number | null): string {
  if (seconds == null) return translateMsg("filer.dateUnknown");
  return ROW_DATE.format(new Date(seconds * 1000));
}

export function friendlyFtpError(error: unknown): string {
  const message = errorText(error);
  if (message.includes("Response contains an invalid syntax")) {
    return translateMsg("ftp.legacyListing");
  }
  return message;
}
