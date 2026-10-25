import { useState } from "react";
import { ModalDialog } from "../components/ModalDialog";
import { useT } from "../useT";
import { formatClock, experimentsOf } from "./model";
import { useWorkbench } from "./store";

/**
 * Every unsaved buffer the backend has on disk, across projects and servers.
 * This is the recovery path for a restart, a full disk at close time, or a
 * draft written before a project's server identity changed: the tab may be
 * gone, but the content is listed here with the identity it belongs to.
 */
export function DraftsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const drafts = useWorkbench((state) => state.drafts);
  const data = useWorkbench((state) => state.data);
  const workspaces = data.workspaces;
  const error = useWorkbench((state) => state.draftsError);
  const dir = useWorkbench((state) => state.draftsDir);
  const bytes = useWorkbench((state) => state.draftsBytes);
  const unreadable = useWorkbench((state) => state.draftsUnreadable);
  const discardDraft = useWorkbench((state) => state.discardDraft);
  const activateWorkspace = useWorkbench((state) => state.activateWorkspace);
  const openFile = useWorkbench((state) => state.openFile);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const open = async (docId: string) => {
    const draft = drafts.find((item) => item.docId === docId);
    if (!draft) return;
    const workspace = workspaces.find((item) => item.id === draft.workspaceId);
    if (!workspace) return;
    setBusy(docId);
    try {
      activateWorkspace(workspace.id);
      // The draft may live under an experiment root outside the project root;
      // pick the experiment whose directory actually contains the path.
      const experiment = experimentsOf(data, workspace.id).find((item) => {
        const root = item.root?.replace(/\/+$/, "");
        return root ? draft.absolutePath.startsWith(`${root}/`) : false;
      });
      const root = (experiment?.root ?? workspace.root).replace(/\/+$/, "");
      const relative = draft.absolutePath.startsWith(`${root}/`)
        ? draft.absolutePath.slice(root.length + 1)
        : draft.path;
      await openFile(workspace.id, experiment?.id ?? "", relative);
      onClose();
    } finally {
      setBusy(null);
    }
  };

  return (
    <ModalDialog open onClose={onClose} contentClassName="wb-drafts-dialog">
      <div className="dialog-header">
        <span>{t("wb.draftsTitle")}</span>
        <span className="wb-drafts-count">{drafts.length}</span>
      </div>
      <div className="dialog-body wb-drafts-body">
        <p className="wb-drafts-hint">{t("wb.draftsHint")}</p>
        {error && (
          <div className="wb-banner is-error" role="alert">
            <span>{t("wb.draftsError", { error })}</span>
          </div>
        )}
        {unreadable > 0 && (
          <div className="wb-banner is-warning">
            <span>{t("wb.draftsUnreadable", { count: String(unreadable) })}</span>
          </div>
        )}
        {drafts.length === 0 ? (
          <p className="wb-drafts-empty">{t("wb.draftsEmpty")}</p>
        ) : (
          <ul className="wb-drafts-list">
            {drafts.map((draft) => {
              const workspace = workspaces.find((item) => item.id === draft.workspaceId);
              return (
                <li key={draft.docId} className="wb-drafts-row">
                  <div className="wb-drafts-identity">
                    <strong>{workspace?.name ?? draft.projectName}</strong>
                    <span className="wb-server-chip">{draft.serverLabel || draft.serverKey}</span>
                  </div>
                  <div className="wb-drafts-path" title={draft.absolutePath}>
                    {draft.path || draft.absolutePath}
                  </div>
                  <div className="wb-drafts-meta">
                    <span>
                      {t("wb.draftSize", { size: draft.content.length.toLocaleString() })}
                    </span>
                    <span>{t("wb.draftUpdated", { time: formatClock(draft.updatedAt) })}</span>
                    {!workspace && (
                      <span className="wb-drafts-gone">{t("wb.draftProjectGone")}</span>
                    )}
                  </div>
                  <div className="wb-drafts-actions">
                    {confirming === draft.docId ? (
                      <>
                        <span className="wb-drafts-confirm">
                          {t("wb.draftConfirmDiscard", { path: draft.path })}
                        </span>
                        <button
                          type="button"
                          className="btn is-danger"
                          onClick={() => {
                            setConfirming(null);
                            void discardDraft(draft.docId);
                          }}
                        >
                          {t("wb.draftDiscard")}
                        </button>
                        <button type="button" className="btn" onClick={() => setConfirming(null)}>
                          {t("common.cancel")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn is-primary"
                          disabled={!workspace || busy === draft.docId}
                          title={workspace ? undefined : t("wb.draftProjectGone")}
                          onClick={() => void open(draft.docId)}
                        >
                          {t("wb.draftOpen")}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            if (navigator.clipboard) {
                              void navigator.clipboard.writeText(draft.content);
                            }
                          }}
                        >
                          {t("wb.copyContent")}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setConfirming(draft.docId)}
                        >
                          {t("wb.draftDiscard")}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="dialog-footer">
        <span className="wb-drafts-dir" title={dir}>
          {dir ? t("wb.draftsLocation", { dir }) : ""}
          {bytes > 0 ? ` · ${Math.round(bytes / 1024)} KiB` : ""}
        </span>
        <button type="button" className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </ModalDialog>
  );
}
