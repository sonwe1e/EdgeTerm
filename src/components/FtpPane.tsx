import { useEffect, useState } from "react";
import { reconnectSession } from "../actions";
import { errorText } from "../errorInfo";
import { FileBrowser, Props, ToolButton, formatBytes, remoteParent } from "./ftpPresentation";
import { useFtpActions } from "./useFtpActions";
import { useFtpDirectory } from "./useFtpDirectory";
import { useFtpDrag } from "./useFtpDrag";
import { useFtpTransfer } from "./useFtpTransfer";
export { FileBrowser } from "./ftpPresentation";

import * as api from "../api";
import type { MenuItem } from "./ContextMenu";
import type { FileEntry } from "../types";
import { useStableCallback } from "../useStableCallback";
import { useT } from "../useT";
import { ContextMenu } from "./ContextMenu";
import { DeleteEntryDialog } from "./DeleteEntryDialog";
import { FileDiffDialog } from "./FileDiffDialog";
import { GroupNameDialog } from "./GroupNameDialog";
import { Icon } from "./icons";

interface NamePrompt {
  title: string;
  label: string;
  hint: string;
  initialName?: string;
  submitLabel: string;
  submit: (name: string) => Promise<void>;
}

type Side = "remote" | "local";

interface PendingDelete {
  side: Side;
  entries: FileEntry[];
}

export function FtpPane({ tab, active }: Props) {
  const t = useT();
  const sessionId = tab.info.id;
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null);
  const [comparison, setComparison] = useState<{ local: string; remote: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  useEffect(() => {
    if (tab.state !== "connected") {
      setComparison(null);
      setNamePrompt(null);
      setMenu(null);
      setPendingDelete(null);
    }
  }, [tab.state]);

  // A prompt belongs to the tab that raised it; switching tabs must not
  // leave a modal naming a path from the pane behind it.
  useEffect(() => {
    if (!active) {
      setNamePrompt(null);
      setMenu(null);
      setPendingDelete(null);
    }
  }, [active]);
  // The pane serves both FTP and SFTP file sessions; only the labels differ.
  const protocolLabel = tab.info.kind === "sftp" ? "SFTP" : "FTP";
  const {
    remotePath,
    remoteEntries,
    localPath,
    localEntries,
    setRemoteError,
    setLocalError,
    loadRemote,
    loadLocal,
    selectedLocal,
    selectedRemote,
    remoteDraft,
    remoteSelection,
    remoteLoading,
    remoteError,
    setRemoteDraft,
    remoteHome,
    setRemoteSelection,
    localLoading,
    localDraft,
    localSelection,
    localError,
    setLocalDraft,
    localHome,
    setLocalSelection,
  } = useFtpDirectory({ sessionId, tab });
  const {
    transferring,
    runUpload,
    runDownload,
    upload,
    download,
    uploadEntries,
    downloadEntries,
    transfer,
    transferPercent,
    transferId,
    transferJob,
  } = useFtpTransfer({
    remotePath,
    remoteEntries,
    sessionId,
    localPath,
    localEntries,
    setRemoteError,
    setLocalError,
    loadRemote,
    loadLocal,
    selectedLocal,
    selectedRemote,
  });
  const {
    dragging,
    remoteListRef,
    itemPointerDown,
    itemPointerMove,
    itemPointerUp,
    dragCancel,
    dropHover,
    localListRef,
  } = useFtpDrag({ transferring, runUpload, runDownload, active });

  const activateRemote = useStableCallback((entry: FileEntry) => {
    if (entry.isDir) void loadRemote(entry.path);
  });
  const activateLocal = useStableCallback((entry: FileEntry) => {
    if (entry.isDir) void loadLocal(entry.path);
  });
  const {
    createRemoteFolder,
    renameRemote,
    removeRemoteEntries,
    createLocalFolder,
    renameLocal,
    removeLocalEntries,
  } = useFtpActions({
    remotePath,
    transferring,
    setRemoteError,
    sessionId,
    loadRemote,
    selectedRemote,
    localPath,
    setLocalError,
    loadLocal,
    selectedLocal,
  });

  // Rename and compare act on exactly one entry; transfers, delete and the
  // context menu take the whole selection.
  const soleRemote = selectedRemote.length === 1 ? selectedRemote[0] : undefined;
  const soleLocal = selectedLocal.length === 1 ? selectedLocal[0] : undefined;

  const requestName = (side: Side, mode: "create" | "rename", entry?: FileEntry) => {
    const remote = side === "remote";
    const base = remote ? remotePath : localPath;
    const selected = remote ? selectedRemote : selectedLocal;
    // A row menu names its row; the toolbar names the one selected entry.
    const target = entry ?? (selected.length === 1 ? selected[0] : undefined);
    if (!base || (mode === "rename" && !target)) return;
    setNamePrompt({
      title: mode === "create" ? t("ftp.newFolderTitle") : t("ftp.renameTitle"),
      label: mode === "create" ? t("ftp.folderName") : t("ftp.itemName"),
      hint: base,
      initialName: mode === "rename" ? target?.name : "",
      submitLabel: mode === "create" ? t("ftp.create") : t("ftp.rename"),
      submit: async (name) => {
        if (remote) {
          if (mode === "create") await createRemoteFolder(name);
          else await renameRemote(name, target);
        } else if (mode === "create") {
          await createLocalFolder(name);
        } else {
          await renameLocal(name, target);
        }
        setNamePrompt(null);
      },
    });
  };

  /**
   * Delete on the selection: a single entry keeps the confirmation it has
   * always shown, several are confirmed once by the delete dialog, the way
   * the Filer's batch delete is. The removal itself runs here for both.
   */
  const requestDelete = (side: Side, entries: readonly FileEntry[]) => {
    if (entries.length === 0) return;
    if (entries.length === 1) {
      void (side === "remote" ? removeRemoteEntries(entries) : removeLocalEntries(entries));
      return;
    }
    setPendingDelete({ side, entries: [...entries] });
  };

  const closeMenu = useStableCallback(() => setMenu(null));
  const menuLabel = (label: string, count: number) => (count > 1 ? `${label} (${count})` : label);

  /**
   * What a right click on a row offers: the actions the toolbar and rail give
   * the selection, plus Open for a folder. `targets` is the selection the
   * right click left behind, so the menu acts on exactly the rows it shows.
   */
  const rowMenu = (
    side: Side,
    entry: FileEntry,
    targets: readonly FileEntry[],
    at: { x: number; y: number },
  ) => {
    const count = targets.length;
    const uploadSide = side === "local";
    // The row menu names the clicked row, so these actions cannot act on a
    // selection that the right click has not committed yet.
    const opposite = uploadSide ? soleRemote : soleLocal;
    const compareReady = count === 1 && !entry.isDir && !!opposite && !opposite.isDir;
    const items: MenuItem[] = [
      {
        label: menuLabel(uploadSide ? t("ftp.upload") : t("ftp.download"), count),
        icon: uploadSide ? "cloud-upload" : "cloud-download",
        disabled: transferring,
        action: () => (uploadSide ? uploadEntries(targets) : downloadEntries(targets)),
      },
      ...(count === 1 && entry.isDir
        ? [
            {
              label: t("filer.open"),
              icon: "folder-opened" as const,
              action: () =>
                void (side === "remote" ? loadRemote(entry.path) : loadLocal(entry.path)),
            },
          ]
        : []),
      "separator" as const,
      {
        label: t("ftp.compare"),
        icon: "arrow-swap" as const,
        disabled: transferring || !compareReady,
        action: () => {
          if (!opposite || !compareReady) return;
          setComparison(
            uploadSide
              ? { local: entry.path, remote: opposite.path }
              : { local: opposite.path, remote: entry.path },
          );
        },
      },
      {
        label: t("ftp.rename"),
        icon: "edit" as const,
        disabled: count !== 1 || transferring,
        action: () => requestName(side, "rename", entry),
      },
      {
        label: menuLabel(t("common.delete"), count),
        icon: "trash" as const,
        danger: true,
        disabled: transferring,
        action: () => requestDelete(side, targets),
      },
    ];
    setMenu({ x: at.x, y: at.y, items });
  };

  return (
    <div className={`ftp-workspace${active ? "" : " is-hidden"}`}>
      {tab.state !== "connected" ? (
        <div className={`ftp-session-state is-${tab.state}`} role="status">
          <strong>
            {tab.state === "connecting"
              ? t("ftp.connecting", { protocol: protocolLabel })
              : t("ftp.unavailable", { protocol: protocolLabel })}
          </strong>
          <span>{tab.message ?? tab.info.address}</span>
          {(tab.state === "closed" || tab.state === "error") && (
            <button type="button" className="btn" onClick={() => void reconnectSession(sessionId)}>
              {t("common.reconnect")}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className={`ftp-dual-pane${dragging ? " is-dragging" : ""}`}>
            <FileBrowser
              title={t("ftp.serverTitle", { protocol: protocolLabel })}
              subtitle={tab.info.address}
              side="remote"
              listRef={remoteListRef}
              onItemPointerDown={itemPointerDown}
              onItemPointerMove={itemPointerMove}
              onItemPointerUp={itemPointerUp}
              onDragCancel={dragCancel}
              draggingPath={dragging?.entry.path ?? null}
              dropHover={dropHover}
              path={remotePath}
              draft={remoteDraft}
              entries={remoteEntries}
              selection={remoteSelection}
              loading={remoteLoading}
              error={remoteError}
              onDraftChange={setRemoteDraft}
              onOpenPath={(path) => void loadRemote(path)}
              onHome={() => void loadRemote(remoteHome)}
              onParent={() => void loadRemote(remoteParent(remotePath))}
              onRefresh={() => void loadRemote(remotePath || remoteHome)}
              onSelectionChange={setRemoteSelection}
              onRowMenu={rowMenu}
              onActivate={activateRemote}
              actions={
                <>
                  <ToolButton
                    label={t("ftp.newRemoteFolder")}
                    onClick={() => requestName("remote", "create")}
                    disabled={remoteLoading || transferring}
                  >
                    <Icon name="new-folder" />
                  </ToolButton>
                  <ToolButton
                    label={t("ftp.renameRemote")}
                    onClick={() => requestName("remote", "rename")}
                    disabled={!soleRemote || remoteLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label={t("ftp.deleteRemote")}
                    onClick={() => requestDelete("remote", selectedRemote)}
                    disabled={selectedRemote.length === 0 || remoteLoading || transferring}
                    danger
                  >
                    <Icon name="trash" />
                  </ToolButton>
                </>
              }
            />

            <div className="ftp-transfer-rail" aria-label={t("ftp.transferActions")}>
              <button
                className="ftp-transfer-button"
                type="button"
                disabled={
                  !soleLocal ||
                  soleLocal.isDir ||
                  !soleRemote ||
                  soleRemote.isDir ||
                  localLoading ||
                  remoteLoading
                }
                onClick={() => {
                  if (soleLocal && soleRemote)
                    setComparison({ local: soleLocal.path, remote: soleRemote.path });
                }}
                title={t("ftp.compareTitle")}
              >
                {t("ftp.compare")}
              </button>
              <button
                className="ftp-transfer-button"
                onClick={() => upload()}
                disabled={selectedLocal.length === 0 || transferring}
                title={t("ftp.uploadTitle")}
              >
                <span>←</span>
                {t("ftp.upload")}
              </button>
              <button
                className="ftp-transfer-button"
                onClick={() => download()}
                disabled={selectedRemote.length === 0 || transferring}
                title={t("ftp.downloadTitle", { protocol: protocolLabel })}
              >
                {t("ftp.download")}
                <span>→</span>
              </button>
            </div>

            <FileBrowser
              title={t("ftp.localComputer")}
              subtitle={t("ftp.thisDevice")}
              side="local"
              listRef={localListRef}
              onItemPointerDown={itemPointerDown}
              onItemPointerMove={itemPointerMove}
              onItemPointerUp={itemPointerUp}
              onDragCancel={dragCancel}
              draggingPath={dragging?.entry.path ?? null}
              dropHover={dropHover}
              path={localPath}
              draft={localDraft}
              entries={localEntries}
              selection={localSelection}
              loading={localLoading}
              error={localError}
              onDraftChange={setLocalDraft}
              onOpenPath={(path) => void loadLocal(path)}
              onHome={() => void loadLocal(localHome)}
              onParent={() => {
                void api.localParent(localPath).then(loadLocal);
              }}
              onRefresh={() => void loadLocal(localPath || localHome)}
              onSelectionChange={setLocalSelection}
              onRowMenu={rowMenu}
              onActivate={activateLocal}
              actions={
                <>
                  <ToolButton
                    label={t("ftp.newLocalFolder")}
                    onClick={() => requestName("local", "create")}
                    disabled={localLoading || transferring}
                  >
                    <Icon name="new-folder" />
                  </ToolButton>
                  <ToolButton
                    label={t("ftp.renameLocal")}
                    onClick={() => requestName("local", "rename")}
                    disabled={!soleLocal || localLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label={t("ftp.deleteLocal")}
                    onClick={() => requestDelete("local", selectedLocal)}
                    disabled={selectedLocal.length === 0 || localLoading || transferring}
                    danger
                  >
                    <Icon name="trash" />
                  </ToolButton>
                </>
              }
            />
          </div>

          {comparison && (
            <FileDiffDialog
              sessionId={sessionId}
              local={comparison.local}
              remote={comparison.remote}
              active={active}
              onClose={() => setComparison(null)}
            />
          )}
          <div className={`ftp-transfer-status${transfer ? " has-transfer" : ""}`}>
            {transfer ? (
              <>
                <div className="ftp-transfer-summary">
                  <span>
                    {transfer.status === "complete"
                      ? t("ftp.complete")
                      : transfer.status === "error"
                        ? t("ftp.failed")
                        : transfer.status === "cancelled"
                          ? t("ftp.cancelled")
                          : transfer.direction === "upload"
                            ? t("ftp.uploading")
                            : t("ftp.downloading")}
                    : {transfer.name}
                  </span>
                  <span>
                    {formatBytes(transfer.transferred)}
                    {transfer.total > 0 ? ` / ${formatBytes(transfer.total)}` : ""}
                  </span>
                </div>
                <div className="ftp-transfer-progress">
                  <span
                    className={transferPercent === null ? "is-indeterminate" : ""}
                    style={transferPercent === null ? undefined : { width: `${transferPercent}%` }}
                  />
                </div>
                {transfer.message && <div className="ftp-transfer-error">{transfer.message}</div>}
                {transferring && transferId.current && (
                  <div className="transfer-job-actions">
                    <span>
                      {transferJob?.status === "paused"
                        ? t("ftp.paused")
                        : transferJob && transferJob.totalFiles > 0
                          ? t("ftp.filesProgress", {
                              done: transferJob.completedFiles,
                              total: transferJob.totalFiles,
                            })
                          : null}
                    </span>
                    <button
                      type="button"
                      disabled={
                        !transferJob ||
                        !["queued", "running", "retrying", "paused"].includes(transferJob.status)
                      }
                      onClick={() =>
                        void api
                          .controlFileTransfer(
                            transferId.current!,
                            transferJob?.status === "paused" ? "resume" : "pause",
                          )
                          .catch((e) => setRemoteError(errorText(e)))
                      }
                    >
                      {transferJob?.status === "paused" ? t("ftp.resume") : t("ftp.pause")}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void api
                          .cancelTransfer(transferId.current!)
                          .catch((e) => setRemoteError(errorText(e)))
                      }
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <span>{t("ftp.selectToTransfer", { protocol: protocolLabel })}</span>
            )}
          </div>
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {pendingDelete && tab.state === "connected" && (
        <DeleteEntryDialog
          entry={pendingDelete.entries[0]}
          entries={pendingDelete.entries}
          location={pendingDelete.side === "remote" ? tab.info.address : t("ftp.localComputer")}
          onConfirm={() => {
            const { side, entries } = pendingDelete;
            setPendingDelete(null);
            void (side === "remote" ? removeRemoteEntries(entries) : removeLocalEntries(entries));
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {namePrompt && (
        <GroupNameDialog
          title={namePrompt.title}
          location={namePrompt.hint}
          label={namePrompt.label}
          hint={namePrompt.hint}
          initialName={namePrompt.initialName}
          submitLabel={namePrompt.submitLabel}
          onSubmit={namePrompt.submit}
          onCancel={() => setNamePrompt(null)}
        />
      )}
    </div>
  );
}
