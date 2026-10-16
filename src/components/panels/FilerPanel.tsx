import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  FilerEntryIcon,
  FilerRow,
  formatBytes,
  formatEntrySummary,
  loadOpenWithApps,
} from "./filerPresentation";
import { MenuState, NewEntryDraft } from "./filerTypes";
import { useFilerActions } from "./useFilerActions";
import { useFilerDirectory } from "./useFilerDirectory";
import { useFilerDrag } from "./useFilerDrag";
import { useFilerTransfer } from "./useFilerTransfer";
import { useFilerUpload } from "./useFilerUpload";
export { sameListing } from "./filerDirectoryCache";

import { revealCwdInFiler } from "../../actions";
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
  const { download: downloadEntries, choosing: choosingDownload } = useFilerDownloads(
    remoteId,
    setError,
  );
  const [creating, setCreating] = useState<NewEntryDraft | null>(null);
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
  const {
    beginTransfer,
    progressFor,
    finishTransfer,
    failTransfer,
    ownsTransfer,
    updateTransferProgress,
    activeTransfer,
    cancelTransfer,
    transfer,
    transferLabel,
    transferPercent,
    backgroundTransfer,
  } = useFilerTransfer({ setError, t });
  const remoteIdRef = useRef(remoteId);
  const offlineReasonRef = useRef(offlineReason);
  const pathRef = useRef(path);
  const busyRef = useRef(busy);

  remoteIdRef.current = remoteId;
  offlineReasonRef.current = offlineReason;
  pathRef.current = path;
  busyRef.current = busy;

  const closeMenu = useCallback(() => setMenu(null), []);

  const resetSelection = useStableCallback(() => {
    clearSelection();
    collapseSelection.current = null;
  });
  const { load, goUp } = useFilerDirectory({
    offline,
    remoteId,
    clearSelection: resetSelection,
    setBusy,
    setError,
    setPath,
    setDraft,
    setEntries,
    setCreating,
    path,
  });
  const { upload, uploadFolder, uploadPaths, copyPaths } = useFilerUpload({
    remoteId,
    path,
    busyRef,
    setBusy,
    setError,
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
    setError,
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
  const { activate, openMenu, entryMenu, folderMenu, commitNewEntry, removeEntries } =
    useFilerActions({
      setPendingDelete,
      remoteId,
      path,
      busyRef,
      setBusy,
      setError,
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
      upload,
      uploadFolder,
      creating,
      entries,
    });

  const remoteTitle = (label: string) => (remote ? label : `${label}${t("filer.sshOnly")}`);
  // The Windows drive list is virtual: drives can be opened but not created,
  // deleted or navigated above.
  const panelFontSize = useStore((s) => s.panelFontSize);
  // The footer walks every entry; a large directory must not pay that on
  // each of the app's re-renders.
  const entrySummary = useMemo(() => formatEntrySummary(entries), [entries]);

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
          className={`filer-col-date${sort.key === "modified" ? " is-sorted" : ""}`}
          onClick={() => sortBy("modified")}
          aria-label={t("filer.sortByModified")}
        >
          {t("filer.modified")}
          <SortIndicator sort={sort} column="modified" />
        </button>
      </div>

      <div
        className="panel-body filer-list"
        role="listbox"
        aria-multiselectable="true"
        tabIndex={0}
        onMouseDown={(event) => {
          if (
            event.button === 0 &&
            !(event.target as HTMLElement).closest(".filer-entry, .filer-new-entry")
          ) {
            clearSelection();
          }
        }}
        onKeyDown={(event) => {
          if (busy) return;
          if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]"))
            return;
          if ((IS_MAC ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            event.stopPropagation();
            selection.selectAll();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            clearSelection();
          }
        }}
        onContextMenu={(event) => openMenu(event, folderMenu())}
        aria-label={
          remote
            ? t("filer.remoteListAria", {
                proto: tab?.info.protocol.toUpperCase() ?? "",
              })
            : t("filer.localListAria")
        }
      >
        {offlineReason && !error && <div className="panel-empty">{offlineReason}</div>}
        {error && <div className="panel-empty">{error}</div>}
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
          rowHeight={Math.max(24, panelFontSize + 10) + 2}
          resetKey={`${remoteId ?? "local"}:${path}:${sort.key}:${sort.direction}:${!!sort.explicit}`}
        >
          {(entry) => (
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
          )}
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
                        .catch((e) => setError(String(e)));
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
