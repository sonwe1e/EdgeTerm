import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { errorText } from "../../errorInfo";
import {
  FilerEntryIcon,
  FilerRow,
  formatBytes,
  formatEntrySummary,
  loadOpenWithApps,
  pathSegments,
} from "./filerPresentation";
import { MenuState, NewEntryDraft, type RenameDraft } from "./filerTypes";
import { useFilerActions } from "./useFilerActions";
import { useFilerDirectory } from "./useFilerDirectory";
import { useFilerDrag } from "./useFilerDrag";
import { useFilerTransfer } from "./useFilerTransfer";
import { useFilerUpload } from "./useFilerUpload";
export { sameListing } from "./filerDirectoryCache";

import { reconnectSession, revealCwdInFiler } from "../../actions";
import * as api from "../../api";
import { sortFileEntries, toggleFileSort, type SortKey } from "../../fileSort";
import { IS_MAC } from "../../platform";
import { chordLabel } from "../../shortcuts";
import { tabTitle, useActiveTab, useStore } from "../../store";
import type { FileEntry } from "../../types";
import { useFilerDownloads } from "../../useFilerDownloads";
import { useFileSelection } from "../../useFileSelection";
import { useStableCallback } from "../../useStableCallback";
import { useT } from "../../useT";
import { ContextMenu } from "../ContextMenu";
import { DeleteEntryDialog } from "../DeleteEntryDialog";
import { FilerTransferSummary } from "../FilerTransferSummary";
import { Icon } from "../icons";
import { SortIndicator } from "../SortIndicator";
import { VirtualFileRows } from "../VirtualFileRows";

/**
 * Stable id of a rendered option. A path may hold spaces or slashes, which are
 * not allowed in an id, so it is percent-encoded.
 */
const filerOptionId = (path: string): string =>
  `filer-option-${encodeURIComponent(path)}`;

function FilerPanelBase() {
  const t = useT();
  const tab = useActiveTab();
  const theme = useStore((s) => s.theme);
  const sshFiles = Boolean(tab?.info.kind === "ssh" && tab.info.supportsRemoteFiles);
  const remote = sshFiles && tab?.state === "connected";
  // An SSH session that is still connecting or has dropped shows no files at
  // all. Falling back to the local home made a drop meant for the server copy
  // into this machine instead (issue #71).
  const offline = sshFiles && !remote;
  const offlineReason = offline
    ? tab?.state === "connecting"
      ? t("session.connecting")
      : t("filer.offline")
    : null;
  // Null for every session without remote files, so switching between local tabs does not
  // count as a source change and reset where the user was browsing.
  const remoteId = remote ? (tab?.info.id ?? null) : null;
  const revealKey = useStore((s) => chordLabel(s.shortcuts.revealCwd));
  // Shell and SSH sessions have a working directory to reveal (⌘J); file
  // sessions bring their own pane and serial lines have no shell.
  const canReveal = Boolean(
    tab && (tab.info.kind === "local" || tab.info.kind === "ssh") && tab.state === "connected",
  );

  const [path, setPath] = useState("");
  const atDrivesRoot = !remoteId && path === api.LOCAL_DRIVES_ROOT;
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  // The sort lives in the store so the Filer and both dual-pane browsers
  // follow one choice as it changes, instead of each reading the stored
  // preference once at mount and drifting apart.
  const sort = useStore((s) => s.filerSort);
  const setFilerSort = useStore((s) => s.setFilerSort);
  const sortedEntries = useMemo(() => sortFileEntries(entries, sort), [entries, sort]);
  const selection = useFileSelection(sortedEntries);
  const {
    paths: selected,
    selectedEntries,
    clear: clearSelection,
    select: selectEntry,
  } = selection;
  const collapseSelection = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Before the hooks that report through it: `reportError` carries every
  // error that is not the footer's own transfer failure (see the hook).
  const {
    beginTransfer,
    progressFor,
    finishTransfer,
    failTransfer,
    ownsTransfer,
    updateTransferProgress,
    activeTransfer,
    cancelTransfer,
    retryTransfer,
    retryAvailable,
    reportError,
    transfer,
    transferLabel,
    transferPercent,
    backgroundTransfer,
  } = useFilerTransfer({ setError, error, t });
  const { download: downloadEntries, choosing: choosingDownload } = useFilerDownloads(
    remoteId,
    reportError,
  );
  const [creating, setCreating] = useState<NewEntryDraft | null>(null);
  const [renaming, setRenaming] = useState<RenameDraft | null>(null);
  // A rename belongs to one directory of one session; leaving either closes
  // the editor, the way a pending delete confirmation is closed.
  useEffect(() => setRenaming(null), [remoteId, path]);
  const [uploadMenu, setUploadMenu] = useState<{ x: number; y: number } | null>(null);
  // ContextMenu closes itself on any outside mousedown, so by the time the
  // upload button's click fires the menu is already gone; remember whether it
  // was open so the button toggles instead of reopening.
  const uploadMenuWasOpen = useRef(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<readonly FileEntry[] | null>(null);
  useEffect(() => setPendingDelete(null), [remoteId, path]);
  const [openWithApps, setOpenWithApps] = useState<string[]>(loadOpenWithApps);
  const preferencesRevision = useStore((s) => s.panelPreferencesRevision);
  useEffect(() => setOpenWithApps(loadOpenWithApps()), [preferencesRevision]);
  const remoteIdRef = useRef(remoteId);
  const offlineReasonRef = useRef(offlineReason);
  const pathRef = useRef(path);
  const busyRef = useRef(busy);
  /** The listbox: the rows' scroll container and the single Tab stop. */
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * The row the keyboard acts on. It rides alongside the selection instead of
   * replacing it, so Ctrl/Cmd+Arrow can move without changing the choice.
   */
  const activePathRef = useRef<string | null>(null);
  /** Id of the active row, but only while that row is actually mounted. */
  const [activeDescendant, setActiveDescendant] = useState<string | null>(null);

  remoteIdRef.current = remoteId;
  offlineReasonRef.current = offlineReason;
  pathRef.current = path;
  busyRef.current = busy;

  const closeMenu = useCallback(() => setMenu(null), []);

  const resetSelection = useStableCallback(() => {
    clearSelection();
    collapseSelection.current = null;
  });
  /** Opens the inline rename editor on one entry; F2, the toolbar, the menu. */
  const startRename = useStableCallback((entry: FileEntry) => {
    if (busy || atDrivesRoot) return;
    setRenaming({ entry, name: entry.name });
    // The row becomes an input rather than an option, so the listbox must
    // stop pointing at it.
    setActiveDescendant(null);
  });
  const { load, goUp, goHome } = useFilerDirectory({
    offline,
    remoteId,
    clearSelection: resetSelection,
    setBusy,
    setError: reportError,
    setPath,
    setDraft,
    setEntries,
    setCreating,
    path,
  });
  const { upload, uploadFolder, uploadPaths, copyPaths } = useFilerUpload({
    remoteId,
    path,
    entries,
    busyRef,
    setBusy,
    setError: reportError,
    beginTransfer,
    progressFor,
    finishTransfer,
    load,
    failTransfer,
    ownsTransfer,
    remoteIdRef,
    offlineReasonRef,
    updateTransferProgress,
    t,
  });

  const { onEntryPointerDown, onEntryPointerMove, panelRef, dragOver, dragOut } = useFilerDrag({
    remoteId,
    uploadPaths,
    copyPaths,
    offlineReasonRef,
    pathRef,
    t,
    remoteIdRef,
    busyRef,
    setError: reportError,
    setBusy,
    beginTransfer,
    progressFor,
    finishTransfer,
    activeTransfer,
    failTransfer,
    ownsTransfer,
    atDrivesRoot,
    selected,
    selectedEntries,
    collapseSelection,
    selectEntry,
    cancelTransfer,
    busy,
  });
  const { activate, openMenu, entryMenu, folderMenu, commitNewEntry, commitRename, removeEntries } =
    useFilerActions({
      setPendingDelete,
      remoteId,
      path,
      busyRef,
      setBusy,
      setError: reportError,
      remoteIdRef,
      pathRef,
      load,
      selection,
      beginTransfer,
      progressFor,
      finishTransfer,
      failTransfer,
      ownsTransfer,
      setOpenWithApps,
      busy,
      t,
      setMenu,
      openWithApps,
      remote,
      choosingDownload,
      downloadEntries,
      atDrivesRoot,
      setCreating,
      startRename,
      renaming,
      setRenaming,
      upload,
      uploadFolder,
      creating,
      entries,
    });

  const remoteTitle = (label: string) => (remote ? label : `${label}${t("filer.sshOnly")}`);
  // The Windows drive list is virtual: drives can be opened but not created,
  // deleted or navigated above.
  const panelFontSize = useStore((s) => s.panelFontSize);
  /** Row pitch of the virtual list; also the step for scroll-into-view. */
  const rowHeight = Math.max(24, panelFontSize + 10) + 2;
  // The footer walks every entry; a large directory must not pay that on
  // each of the app's re-renders.
  const entrySummary = useMemo(() => formatEntrySummary(entries), [entries]);
  /**
   * Every ancestor of the open folder, for the trail under the path box.
   * Empty at the drives root, which is not a real path.
   */
  const breadcrumbs = path && !atDrivesRoot ? pathSegments(path) : [];

  /** Re-sorts the list for a clicked column caption and remembers the choice. */
  const sortBy = (key: SortKey) => {
    setFilerSort(toggleFileSort(useStore.getState().filerSort, key));
  };

  // The row callbacks go through stable identities (see useStableCallback)
  // so a re-render of this panel — a transfer tick, a drag-over change, a
  // selection elsewhere — leaves the memoised rows' props equal and skipped.
  const rowSelect = useStableCallback((path: string, event: MouseEvent) => {
    if (event.button !== 0 || busy) return;
    event.currentTarget.closest<HTMLElement>(".filer-list")?.focus({ preventScroll: true });
    activePathRef.current = path;
    setActiveDescendant(filerOptionId(path));
    const toggle = IS_MAC ? event.metaKey : event.ctrlKey;
    if (!toggle && !event.shiftKey && selected.size > 1 && selected.has(path)) {
      collapseSelection.current = path;
      return;
    }
    collapseSelection.current = null;
    selectEntry(path, { toggle, range: event.shiftKey });
  });
  const rowActivate = useStableCallback((entry: FileEntry) => activate(entry));
  const rowPointerDown = useStableCallback(
    (entry: FileEntry, event: ReactPointerEvent<HTMLDivElement>) =>
      onEntryPointerDown(entry, event),
  );
  const rowPointerMove = useStableCallback((event: ReactPointerEvent<HTMLDivElement>) =>
    onEntryPointerMove(event),
  );
  const rowContextMenu = useStableCallback((event: MouseEvent, entry: FileEntry) => {
    collapseSelection.current = null;
    const chosen = selected.has(entry.path) ? selectedEntries : [entry];
    if (!selected.has(entry.path)) selectEntry(entry.path);
    openMenu(event, entryMenu(entry, chosen));
  });

  // The rows are memoised components that take no id, so the listbox stamps
  // one on every option it has mounted. Only the virtual window is mounted,
  // so this is a handful of writes — and it keeps the ids out of the row
  // props, which would defeat the memo comparison.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    for (const slot of list.querySelectorAll<HTMLElement>("[data-file-path]")) {
      const path = slot.dataset.filePath;
      const option = slot.firstElementChild;
      if (path && option instanceof HTMLElement) option.id = filerOptionId(path);
    }
  });

  // A new listing drops the active row together with the old rows.
  useEffect(() => {
    const path = activePathRef.current;
    if (path !== null && !sortedEntries.some((entry) => entry.path === path)) {
      activePathRef.current = null;
      setActiveDescendant(null);
    }
  }, [sortedEntries]);

  // Scrolling the window can unmount the active row; the listbox must not
  // keep pointing at an id that is no longer in the document.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const path = activePathRef.current;
      if (path !== null && !document.getElementById(filerOptionId(path))) {
        setActiveDescendant(null);
      }
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      list.removeEventListener("scroll", onScroll);
    };
  }, []);

  /**
   * Scrolls the row at `index` into view and points aria at it, but only once
   * it is mounted. A row outside the virtual window is reached by moving the
   * scroller first and waiting for the window to render it; until then the
   * listbox itself holds the focus, never a dangling id.
   */
  const revealActiveRow = (index: number, path: string) => {
    const id = filerOptionId(path);
    const mounted = document.getElementById(id);
    if (mounted) {
      mounted.scrollIntoView({ block: "nearest" });
      setActiveDescendant(id);
      return;
    }
    const rows = listRef.current?.querySelector<HTMLElement>(".virtual-file-rows");
    const scroller = rows?.parentElement;
    setActiveDescendant(null);
    if (!rows || !scroller) return;
    // Same origin VirtualFileRows measures from: anything above the rows (the
    // inline create row) shifts them down in the scroller.
    const offset =
      rows.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      scroller.clientTop;
    const top = offset + index * rowHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + rowHeight - scroller.clientHeight;
    }
    let attempts = 0;
    const settle = () => {
      const rendered = document.getElementById(id);
      if (rendered) {
        rendered.scrollIntoView({ block: "nearest" });
        setActiveDescendant(id);
        return;
      }
      if (attempts++ < 4) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  };

  /** Moves the keyboard cursor and applies the selection mode it came with. */
  const moveActive = (next: number, mode: "select" | "extend" | "move") => {
    if (sortedEntries.length === 0) return;
    const index = Math.max(0, Math.min(sortedEntries.length - 1, next));
    const entry = sortedEntries[index];
    if (!entry) return;
    activePathRef.current = entry.path;
    if (mode !== "move") {
      collapseSelection.current = null;
      selectEntry(entry.path, { range: mode === "extend" });
    }
    revealActiveRow(index, entry.path);
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (busy) return;
    if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]"))
      return;
    const ctrl = IS_MAC ? event.metaKey : event.ctrlKey;
    if (ctrl && event.key.toLowerCase() === "a") {
      event.preventDefault();
      event.stopPropagation();
      selection.selectAll();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
      return;
    }
    if (event.key === "Backspace") {
      // Works in an empty folder too, so it is handled before the list check.
      if (atDrivesRoot || !path) return;
      event.preventDefault();
      void goUp();
      return;
    }
    if (sortedEntries.length === 0) return;
    const active =
      activePathRef.current === null
        ? -1
        : sortedEntries.findIndex((entry) => entry.path === activePathRef.current);
    const mode = event.shiftKey ? "extend" : ctrl ? "move" : "select";
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(active < 0 ? 0 : active + 1, mode);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveActive(active < 0 ? sortedEntries.length - 1 : active - 1, mode);
        return;
      case "Home":
        event.preventDefault();
        moveActive(0, mode);
        return;
      case "End":
        event.preventDefault();
        moveActive(sortedEntries.length - 1, mode);
        return;
      case "PageUp":
      case "PageDown": {
        event.preventDefault();
        const page = Math.max(
          1,
          Math.floor((listRef.current?.clientHeight ?? 0) / rowHeight),
        );
        moveActive(
          (active < 0 ? 0 : active) + (event.key === "PageDown" ? page : -page),
          mode,
        );
        return;
      }
      case "F2": {
        event.preventDefault();
        // The keyboard cursor, or the one selected entry, is what gets
        // renamed; a group cannot be, so a wider selection does nothing.
        const focused =
          activePathRef.current ?? (selected.size === 1 ? selectedEntries[0]?.path : null);
        const entry =
          focused === null ? undefined : sortedEntries.find((item) => item.path === focused);
        if (entry) startRename(entry);
        return;
      }
      case "Delete": {
        // The key every file manager binds to removing the selection. The
        // confirmation dialog and the drives-root guard are the toolbar's,
        // so the keyboard reaches exactly the same path.
        event.preventDefault();
        if (!atDrivesRoot && selectedEntries.length > 0) setPendingDelete(selectedEntries);
        return;
      }
      case "Enter": {
        event.preventDefault();
        const entry = active >= 0 ? sortedEntries[active] : undefined;
        if (entry) activate(entry);
        return;
      }
    }
  };

  return (
    <div
      ref={panelRef}
      className={`panel filer-panel${dragOver ? (dragOver.accept ? " is-drag-over" : dragOver.reason ? " is-drag-blocked" : "") : ""}`}
      style={{ flex: 1 }}
    >
      <div className="panel-header">
        <div className="panel-title is-filer">
          <Icon name="folder" />
          {t("panel.filer")}
          <span className="panel-badge">
            {remote || offline ? tab?.info.protocol : t("filer.local")}
          </span>
        </div>
      </div>

      {/* Upload and download stay visible on local sessions, just disabled. */}
      <div className="filer-toolbar" role="toolbar" aria-label={t("filer.fileActions")}>
        <button
          className="panel-action filer-action"
          onClick={() => setCreating({ kind: "file", name: "" })}
          title={t("filer.newFileBtn")}
          aria-label={t("filer.newFileBtn")}
          disabled={busy || !path || atDrivesRoot}
        >
          <Icon name="new-file" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => setCreating({ kind: "folder", name: "" })}
          title={t("filer.newFolderBtn")}
          aria-label={t("filer.newFolderBtn")}
          disabled={busy || !path || atDrivesRoot}
        >
          <Icon name="new-folder" />
        </button>
        <button
          className={`panel-action filer-action${uploadMenu ? " is-open" : ""}`}
          onMouseDown={() => {
            uploadMenuWasOpen.current = uploadMenu !== null;
          }}
          onClick={(event) => {
            if (uploadMenuWasOpen.current) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setUploadMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
          title={remoteTitle(t("filer.uploadFilesOrFolders"))}
          aria-label={t("filer.uploadFilesOrFolders")}
          aria-haspopup="menu"
          aria-expanded={uploadMenu !== null}
          disabled={!remote || busy || !path}
        >
          <Icon name="cloud-upload" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => void downloadEntries(selectedEntries)}
          title={remoteTitle(t("filer.downloadFileOrFolder"))}
          aria-label={t("filer.downloadFileOrFolder")}
          disabled={!remote || selectedEntries.length === 0 || busy || choosingDownload}
        >
          <Icon name="cloud-download" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => void load(path)}
          title={t("filer.refresh")}
          aria-label={t("filer.refresh")}
          disabled={busy || offline}
        >
          <Icon name="refresh" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => {
            const entry = selectedEntries[0];
            if (entry) startRename(entry);
          }}
          title={t("filer.rename")}
          aria-label={t("filer.rename")}
          disabled={selectedEntries.length !== 1 || busy || atDrivesRoot}
        >
          <Icon name="edit" />
        </button>
        <button
          className="panel-action filer-action filer-action-danger"
          onClick={() => setPendingDelete(selectedEntries)}
          title={t("common.delete")}
          aria-label={t("common.delete")}
          disabled={selectedEntries.length === 0 || busy || atDrivesRoot}
        >
          <Icon name="trash" />
        </button>
      </div>
      {uploadMenu && (
        <ContextMenu
          x={uploadMenu.x}
          y={uploadMenu.y}
          items={[
            {
              label: t("filer.uploadFiles"),
              icon: "cloud-upload",
              action: () => void upload(),
            },
            {
              label: t("filer.uploadFolder"),
              icon: "cloud-upload",
              action: () => void uploadFolder(),
            },
          ]}
          onClose={() => setUploadMenu(null)}
        />
      )}

      <div className="filer-path">
        <button
          className="panel-action filer-action"
          onClick={goUp}
          title={t("filer.parentFolder")}
          aria-label={t("filer.parentFolder")}
          disabled={busy || !path || atDrivesRoot}
        >
          <Icon name="arrow-up" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => void goHome()}
          title={t("filer.home")}
          aria-label={t("filer.home")}
          disabled={busy || offline}
        >
          <Icon name="home" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => tab && void revealCwdInFiler(tab.info.id)}
          title={
            revealKey ? `${t("filer.terminalFolder")} (${revealKey})` : t("filer.terminalFolder")
          }
          aria-label={t("filer.terminalFolder")}
          disabled={busy || !canReveal}
        >
          <Icon name="target" />
        </button>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load(draft);
            if (event.key === "Escape") setDraft(path);
          }}
        />
      </div>

      {breadcrumbs.length > 0 && (
        <nav className="filer-breadcrumbs" aria-label={path}>
          {breadcrumbs.flatMap((segment, index) => [
            ...(index > 0
              ? [
                  <span
                    key={`separator-${segment.target}`}
                    className="filer-crumb-separator"
                    aria-hidden="true"
                  >
                    ›
                  </span>,
                ]
              : []),
            <button
              key={segment.target}
              type="button"
              className="filer-crumb"
              // The full path rides along: a deep segment is ellipsised in a
              // narrow panel, and its target is the one thing worth showing.
              title={segment.target}
              disabled={busy}
              aria-current={index === breadcrumbs.length - 1 ? "location" : undefined}
              onClick={() => void load(segment.target)}
            >
              {segment.label}
            </button>,
          ])}
        </nav>
      )}

      <div className="filer-columns">
        <button
          type="button"
          className={`filer-col-name${sort.key === "name" ? " is-sorted" : ""}`}
          onClick={() => sortBy("name")}
          aria-label={t("filer.sortByName")}
        >
          {t("session.name")}
          <SortIndicator sort={sort} column="name" />
        </button>
        <button
          type="button"
          className={`filer-col-size${sort.key === "size" ? " is-sorted" : ""}`}
          onClick={() => sortBy("size")}
          aria-label={t("filer.sortBySize")}
        >
          {t("filer.size")}
          <SortIndicator sort={sort} column="size" />
        </button>
        <button
          type="button"
          className={`filer-col-date${sort.key === "modified" ? " is-sorted" : ""}`}
          onClick={() => sortBy("modified")}
          aria-label={t("filer.sortByModified")}
        >
          {t("filer.modified")}
          <SortIndicator sort={sort} column="modified" />
        </button>
      </div>

      <div
        ref={listRef}
        className="panel-body filer-list"
        role="listbox"
        aria-multiselectable="true"
        aria-activedescendant={activeDescendant ?? undefined}
        tabIndex={0}
        onMouseDown={(event) => {
          if (
            event.button === 0 &&
            !(event.target as HTMLElement).closest(".filer-entry, .filer-new-entry")
          ) {
            clearSelection();
          }
        }}
        onKeyDown={onListKeyDown}
        onContextMenu={(event) => openMenu(event, folderMenu())}
        aria-label={
          remote
            ? t("filer.remoteListAria", {
                proto: tab?.info.protocol.toUpperCase() ?? "",
              })
            : t("filer.localListAria")
        }
      >
        {offlineReason && !error && (
          <div className="panel-empty is-offline" role="status">
            <span>{offlineReason}</span>
            {tab && (tab.state === "closed" || tab.state === "error") && (
              <button
                type="button"
                className="panel-empty-action"
                onClick={() => void reconnectSession(tab.info.id)}
              >
                {t("common.reconnect")}
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="panel-empty is-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="panel-empty-action"
              onClick={() => (retryAvailable ? retryTransfer() : void load(path || draft))}
            >
              {t("common.retry")}
            </button>
          </div>
        )}
        {!offlineReason && !error && entries.length === 0 && creating === null && (
          <div className="panel-empty" role={busy ? "status" : undefined}>
            {busy ? t("filer.loading") : t("filer.emptyFolder")}
          </div>
        )}
        {creating !== null && (
          <div className="row filer-new-entry">
            <FilerEntryIcon name={creating.name} isDir={creating.kind === "folder"} theme={theme} />
            <input
              autoFocus
              value={creating.name}
              placeholder={
                creating.kind === "folder" ? t("filer.newFolderName") : t("filer.newFileName")
              }
              onChange={(event) => setCreating({ ...creating, name: event.target.value })}
              onBlur={commitNewEntry}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitNewEntry();
                if (event.key === "Escape") setCreating(null);
              }}
            />
          </div>
        )}
        <VirtualFileRows
          entries={sortedEntries}
          rowHeight={rowHeight}
          resetKey={`${remoteId ?? "local"}:${path}:${sort.key}:${sort.direction}:${!!sort.explicit}`}
        >
          {(entry) => {
            const draft = renaming && renaming.entry.path === entry.path ? renaming : null;
            // The row itself becomes the editor, the way a file manager
            // renames in place.
            return draft ? (
              <div className="row filer-new-entry" key={entry.path}>
                <FilerEntryIcon name={entry.name} isDir={entry.isDir} theme={theme} />
                <input
                  autoFocus
                  value={draft.name}
                  placeholder={t("filer.renameName")}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setRenaming({ ...draft, name: event.target.value })}
                  onBlur={() => void commitRename()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRename();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              </div>
            ) : (
              <FilerRow
                key={entry.path}
                entry={entry}
                selected={selected.has(entry.path)}
                draggingOut={dragOut?.path === entry.path}
                theme={theme}
                onSelect={rowSelect}
                onActivate={rowActivate}
                onPointerDown={rowPointerDown}
                onPointerMove={rowPointerMove}
                onContextMenu={rowContextMenu}
              />
            );
          }}
        </VirtualFileRows>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {pendingDelete && (
        <DeleteEntryDialog
          entry={pendingDelete[0]}
          entries={pendingDelete}
          location={remote ? (tab ? tabTitle(tab) : t("filer.remote")) : t("filer.local")}
          onConfirm={() => void removeEntries(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {remoteId && <FilerTransferSummary sessionId={remoteId} />}
      <div className={`filer-footer${transfer ? " has-transfer" : ""}`}>
        {transfer ? (
          <div
            className={`filer-transfer is-${transfer.status}`}
            role="progressbar"
            aria-label={`${transferLabel}: ${transfer.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={transferPercent ?? undefined}
            aria-valuetext={
              transfer.total > 0
                ? t("filer.ofAt", {
                    transferred: formatBytes(transfer.transferred),
                    total: formatBytes(transfer.total),
                    rate: formatBytes(transfer.bytesPerSecond),
                  })
                : t("filer.atRate", {
                    transferred: formatBytes(transfer.transferred),
                    rate: formatBytes(transfer.bytesPerSecond),
                  })
            }
          >
            <div className="filer-transfer-label">
              <span className="filer-transfer-name" title={transfer.name}>
                {transferLabel}: {transfer.name}
              </span>
              <span className="filer-transfer-value">
                {transfer.status === "error"
                  ? t("filer.failed")
                  : transfer.status === "cancelled"
                    ? t("filer.cancelled")
                    : transferPercent === null
                      ? formatBytes(transfer.transferred)
                      : `${transferPercent}%`}
              </span>
              {transfer.status === "running" && transfer.cancellable && (
                <button
                  type="button"
                  className="panel-action filer-action"
                  disabled={
                    !backgroundTransfer ||
                    !["queued", "running", "retrying", "paused"].includes(backgroundTransfer.status)
                  }
                  onClick={() => {
                    const id = activeTransfer.current?.id;
                    if (id)
                      void api
                        .controlFileTransfer(
                          id,
                          backgroundTransfer?.status === "paused" ? "resume" : "pause",
                        )
                        .catch((e) => reportError(errorText(e)));
                  }}
                  title={
                    backgroundTransfer?.status === "paused" ? t("filer.resume") : t("filer.pause")
                  }
                  aria-label={
                    backgroundTransfer?.status === "paused"
                      ? t("filer.resumeTransfer")
                      : t("filer.pauseTransfer")
                  }
                >
                  <Icon name={backgroundTransfer?.status === "paused" ? "play" : "debug-pause"} />
                </button>
              )}
              {transfer.status === "running" && transfer.cancellable && (
                <button
                  className="panel-action filer-action filer-transfer-cancel"
                  onClick={cancelTransfer}
                  title={t("common.cancel")}
                  aria-label={t("filer.cancelName", { name: transfer.name })}
                >
                  <Icon name="close" />
                </button>
              )}
              {transfer.status === "error" && retryAvailable && (
                <button
                  type="button"
                  className="panel-action filer-action filer-transfer-retry"
                  onClick={retryTransfer}
                  title={t("filer.retryName", { name: transfer.name })}
                  aria-label={t("filer.retryName", { name: transfer.name })}
                >
                  <Icon name="debug-restart" />
                </button>
              )}
            </div>
            <div
              className={`filer-transfer-track${transferPercent === null && transfer.status === "running" ? " is-indeterminate" : ""}`}
            >
              <span
                className="filer-transfer-bar"
                style={transferPercent === null ? undefined : { width: `${transferPercent}%` }}
              />
            </div>
            <div className="filer-transfer-meta">
              <span>
                {formatBytes(transfer.transferred)}
                {transfer.total > 0 && ` / ${formatBytes(transfer.total)}`}
              </span>
              <span title={t("filer.transferSpeed")}>{formatBytes(transfer.bytesPerSecond)}/s</span>
            </div>
          </div>
        ) : dragOver?.accept ? (
          <span className="filer-drop-message">
            {remote ? t("filer.dropUpload") : t("filer.dropCopy")}
          </span>
        ) : dragOver?.reason ? (
          <span className="filer-drop-blocked">{dragOver.reason}</span>
        ) : (
          <>
            <span>{entrySummary}</span>
            {selectedEntries.length > 0 && (
              <span>{t("filer.selectedCount", { count: selectedEntries.length })}</span>
            )}
            {busy && <span>{t("filer.working")}</span>}
          </>
        )}
      </div>
    </div>
  );
}

// The Filer takes no props: memoising it keeps the app's re-renders (a tab
// switch, a status change) from re-walking a large directory's rows.
export const FilerPanel = memo(FilerPanelBase);
