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
import type { FileEntry } from "../types";
import { useStableCallback } from "../useStableCallback";
import { useT } from "../useT";
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

export function FtpPane({ tab, active }: Props) {
  const t = useT();
  const sessionId = tab.info.id;
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null);
  const [comparison, setComparison] = useState<{ local: string; remote: string } | null>(null);
  useEffect(() => {
    if (tab.state !== "connected") {
      setComparison(null);
      setNamePrompt(null);
    }
  }, [tab.state]);

  // A prompt belongs to the tab that raised it; switching tabs must not
  // leave a modal naming a path from the pane behind it.
  useEffect(() => {
    if (!active) setNamePrompt(null);
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
    remoteSelected,
    remoteLoading,
    remoteError,
    setRemoteDraft,
    remoteHome,
    setRemoteSelected,
    localLoading,
    localDraft,
    localSelected,
    localError,
    setLocalDraft,
    localHome,
    setLocalSelected,
  } = useFtpDirectory({ sessionId, tab });
  const {
    transferring,
    runUpload,
    runDownload,
    upload,
    download,
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
    removeRemote,
    createLocalFolder,
    renameLocal,
    removeLocal,
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

  const requestName = (side: "remote" | "local", mode: "create" | "rename") => {
    const remote = side === "remote";
    const base = remote ? remotePath : localPath;
    const selected = remote ? selectedRemote : selectedLocal;
    if (!base || (mode === "rename" && !selected)) return;
    setNamePrompt({
      title: mode === "create" ? t("ftp.newFolderTitle") : t("ftp.renameTitle"),
      label: mode === "create" ? t("ftp.folderName") : t("ftp.itemName"),
      hint: base,
      initialName: mode === "rename" ? selected?.name : "",
      submitLabel: mode === "create" ? t("ftp.create") : t("ftp.rename"),
      submit: async (name) => {
        if (remote) {
          if (mode === "create") await createRemoteFolder(name);
          else await renameRemote(name);
        } else if (mode === "create") {
          await createLocalFolder(name);
        } else {
          await renameLocal(name);
        }
        setNamePrompt(null);
      },
    });
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
            <button
              type="button"
              className="btn"
              onClick={() => void reconnectSession(sessionId)}
            >
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
              selected={remoteSelected}
              loading={remoteLoading}
              error={remoteError}
              onDraftChange={setRemoteDraft}
              onOpenPath={(path) => void loadRemote(path)}
              onHome={() => void loadRemote(remoteHome)}
              onParent={() => void loadRemote(remoteParent(remotePath))}
              onRefresh={() => void loadRemote(remotePath || remoteHome)}
              onSelect={setRemoteSelected}
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
                    disabled={!selectedRemote || remoteLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label={t("ftp.deleteRemote")}
                    onClick={() => void removeRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
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
                  !selectedLocal ||
                  selectedLocal.isDir ||
                  !selectedRemote ||
                  selectedRemote.isDir ||
                  localLoading ||
                  remoteLoading
                }
                onClick={() => {
                  if (selectedLocal && selectedRemote)
                    setComparison({ local: selectedLocal.path, remote: selectedRemote.path });
                }}
                title={t("ftp.compareTitle")}
              >
                {t("ftp.compare")}
              </button>
              <button
                className="ftp-transfer-button"
                onClick={() => void upload()}
                disabled={!selectedLocal || transferring}
                title={t("ftp.uploadTitle")}
              >
                <span>←</span>
                {t("ftp.upload")}
              </button>
              <button
                className="ftp-transfer-button"
                onClick={() => void download()}
                disabled={!selectedRemote || transferring}
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
              selected={localSelected}
              loading={localLoading}
              error={localError}
              onDraftChange={setLocalDraft}
              onOpenPath={(path) => void loadLocal(path)}
              onHome={() => void loadLocal(localHome)}
              onParent={() => {
                void api.localParent(localPath).then(loadLocal);
              }}
              onRefresh={() => void loadLocal(localPath || localHome)}
              onSelect={setLocalSelected}
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
                    disabled={!selectedLocal || localLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label={t("ftp.deleteLocal")}
                    onClick={() => void removeLocal()}
                    disabled={!selectedLocal || localLoading || transferring}
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
