import { useEffect, useState } from "react";
import { FileBrowser, Props, ToolButton, formatBytes, remoteParent } from "./ftpPresentation";
import { useFtpActions } from "./useFtpActions";
import { useFtpDirectory } from "./useFtpDirectory";
import { useFtpDrag } from "./useFtpDrag";
import { useFtpTransfer } from "./useFtpTransfer";
export { FileBrowser } from "./ftpPresentation";

import * as api from "../api";
import type { FileEntry } from "../types";
import { useStableCallback } from "../useStableCallback";
import { FileDiffDialog } from "./FileDiffDialog";
import { Icon } from "./icons";

export function FtpPane({ tab, active }: Props) {
  const sessionId = tab.info.id;
  const [comparison, setComparison] = useState<{ local: string; remote: string } | null>(null);
  useEffect(() => {
    if (tab.state !== "connected") setComparison(null);
  }, [tab.state]);
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

  return (
    <div className={`ftp-workspace${active ? "" : " is-hidden"}`}>
      {tab.state !== "connected" ? (
        <div className={`ftp-session-state is-${tab.state}`}>
          <strong>
            {tab.state === "connecting"
              ? `Connecting to ${protocolLabel}…`
              : `${protocolLabel} unavailable`}
          </strong>
          <span>{tab.message ?? tab.info.address}</span>
        </div>
      ) : (
        <>
          <div className={`ftp-dual-pane${dragging ? " is-dragging" : ""}`}>
            <FileBrowser
              title={`${protocolLabel} Server`}
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
                    label="New remote folder"
                    onClick={() => void createRemoteFolder()}
                    disabled={remoteLoading || transferring}
                  >
                    <Icon name="new-folder" />
                  </ToolButton>
                  <ToolButton
                    label="Rename remote item"
                    onClick={() => void renameRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label="Delete remote item"
                    onClick={() => void removeRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
                    danger
                  >
                    <Icon name="trash" />
                  </ToolButton>
                </>
              }
            />

            <div className="ftp-transfer-rail" aria-label="File transfer actions">
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
                title="Compare selected local and remote files"
              >
                Compare
              </button>
              <button
                className="ftp-transfer-button"
                onClick={() => void upload()}
                disabled={!selectedLocal || transferring}
                title="Upload selected local file or folder"
              >
                <span>←</span>
                Upload
              </button>
              <button
                className="ftp-transfer-button"
                onClick={() => void download()}
                disabled={!selectedRemote || transferring}
                title={`Download selected ${protocolLabel} file or folder`}
              >
                Download
                <span>→</span>
              </button>
            </div>

            <FileBrowser
              title="Local Computer"
              subtitle="This device"
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
                    label="New local folder"
                    onClick={() => void createLocalFolder()}
                    disabled={localLoading || transferring}
                  >
                    <Icon name="new-folder" />
                  </ToolButton>
                  <ToolButton
                    label="Rename local item"
                    onClick={() => void renameLocal()}
                    disabled={!selectedLocal || localLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label="Delete local item"
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
                      ? "Complete"
                      : transfer.status === "error"
                        ? "Failed"
                        : transfer.status === "cancelled"
                          ? "Cancelled"
                          : transfer.direction === "upload"
                            ? "Uploading"
                            : "Downloading"}
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
                    <span>{transferJob?.status === "paused" ? "Paused" : transferJob?.phase}</span>
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
                          .catch((e) => setRemoteError(String(e)))
                      }
                    >
                      {transferJob?.status === "paused" ? "Resume" : "Pause"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void api
                          .cancelTransfer(transferId.current!)
                          .catch((e) => setRemoteError(String(e)))
                      }
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            ) : (
              <span>{`Select a local file or folder to upload, or a ${protocolLabel} file or folder to download.`}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
