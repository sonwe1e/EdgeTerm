import { useEffect, useState } from "react";
import { useStore } from "../store";
import { isLightTheme } from "../types";
import { useT } from "../useT";
import { CodeEditor } from "./CodeEditor";
import { formatClock } from "./model";
import { docSyncLabel, useWorkbench } from "./store";
import { ModalDialog } from "../components/ModalDialog";
import { Icon } from "../components/icons";

export function EditorArea({
  onBrowseFiles,
  onQuickOpen,
  onSearch,
  onCompare,
}: {
  onBrowseFiles?: () => void;
  onQuickOpen: () => void;
  onSearch: () => void;
  onCompare: (path: string) => void;
}) {
  const t = useT();
  const theme = useStore((state) => state.theme);
  const bufferFontSize = useStore((state) => state.bufferFontSize);
  const docs = useWorkbench((state) => state.docs);
  const activeDocId = useWorkbench((state) => state.activeDocId);
  const activateDoc = useWorkbench((state) => state.activateDoc);
  const updateDoc = useWorkbench((state) => state.updateDoc);
  const saveDoc = useWorkbench((state) => state.saveDoc);
  const reloadDoc = useWorkbench((state) => state.reloadDoc);
  const closeDoc = useWorkbench((state) => state.closeDoc);
  const retryDraft = useWorkbench((state) => state.retryDraft);
  const clearReveal = useWorkbench((state) => state.clearReveal);
  const setDraftsOpen = useWorkbench((state) => state.setDraftsOpen);
  const [closing, setClosing] = useState<string | null>(null);
  const [reloading, setReloading] = useState<string | null>(null);
  const [dismissedConflict, setDismissedConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const doc = docs.find((item) => item.id === activeDocId) ?? null;
  const dark = !isLightTheme(theme);

  useEffect(() => {
    // A new change to the server copy needs its own decision, even if the
    // previous banner for this document was dismissed.
    setDismissedConflict(null);
  }, [doc?.remoteHash]);

  const requestClose = (id: string) => {
    const target = docs.find((item) => item.id === id);
    if (!target) return;
    if (target.content !== target.savedContent) setClosing(id);
    else void closeDoc(id);
  };

  // A reload replaces the buffer with the server copy. A dirty buffer is the
  // user's unsaved work, so it gets the same explicit decision as a close.
  const requestReload = (id: string) => {
    const target = docs.find((item) => item.id === id);
    if (!target) return;
    if (target.content !== target.savedContent) setReloading(id);
    else void reloadDoc(id);
  };

  const save = async (force = false) => {
    if (!doc || saving) return;
    setSaving(true);
    try {
      await saveDoc(doc.id, force);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="wb-editor" aria-label={t("wb.title")}>
      <div className="wb-editor-tabs" role="tablist">
        {docs.map((item) => {
          const dirty = item.content !== item.savedContent;
          return (
            <div
              key={item.id}
              className={`wb-editor-tab${item.id === activeDocId ? " is-active" : ""}`}
              role="tab"
              aria-selected={item.id === activeDocId}
              title={`${item.serverLabel} · ${item.absolutePath}`}
              onMouseDown={() => activateDoc(item.id)}
            >
              <span
                className={`wb-editor-dot is-${item.sync}${dirty ? " is-dirty" : ""}${
                  item.remoteHash ? " is-remote" : ""
                }${item.draftState === "failed" ? " is-draft-failed" : ""}`}
                aria-hidden="true"
              />
              <span className="wb-editor-tab-name">{item.path.split("/").pop()}</span>
              {dirty && (
                <span
                  className={`wb-dirty-mark${item.draftState === "failed" ? " is-failed" : ""}`}
                  title={
                    item.draftState === "failed"
                      ? t("wb.draftNotStored")
                      : item.draftState === "saved"
                        ? t("wb.draftStored")
                        : t("wb.unsaved")
                  }
                  aria-label={t("wb.unsaved")}
                >
                  ●
                </span>
              )}
              <button
                type="button"
                className="wb-tab-close"
                aria-label={t("wb.close")}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  requestClose(item.id);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
        <div className="wb-editor-tab-actions">
          <button
            type="button"
            className="wb-icon-button"
            title={t("wb.quickOpen")}
            onClick={onQuickOpen}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="wb-icon-button"
            title={t("wb.search")}
            onClick={onSearch}
          >
            <Icon name="find-in-files" />
          </button>
        </div>
      </div>

      {!doc ? (
        <div className="wb-editor-empty">
          <Icon name="edit" />
          <h2>{t("wb.noFile")}</h2>
          <p>{t("wb.noFileHint")}</p>
          {onBrowseFiles && (
            <button type="button" className="btn is-primary" onClick={onBrowseFiles}>
              {t("wb.browseFiles")}
            </button>
          )}
          <button type="button" className="btn" onClick={onQuickOpen}>
            {t("wb.quickOpen")}
          </button>
        </div>
      ) : (
        <>
          <div className="wb-editor-toolbar">
            <div className="wb-breadcrumb" title={doc.absolutePath}>
              <span className="wb-project-name">{doc.projectName}</span>
              <span className="wb-breadcrumb-sep">/</span>
              <span className="wb-server-chip" title={doc.serverLabel}>
                {doc.serverLabel}
              </span>
              <span className="wb-breadcrumb-sep">/</span>
              <span className="wb-path">{doc.path}</span>
            </div>
            <div className="wb-editor-actions">
              <span className={`wb-sync is-${doc.sync}${doc.remoteHash ? " is-changed" : ""}`}>
                {docSyncLabel(doc)}
                {doc.modifiedAt && doc.sync === "synced" ? (
                  <small>{t("wb.lastSaved", { time: formatClock(doc.modifiedAt) })}</small>
                ) : null}
              </span>
              <button
                type="button"
                className="btn is-primary wb-save"
                disabled={saving || doc.sync === "loading" || doc.content === doc.savedContent}
                onClick={() => void save()}
              >
                {saving ? t("wb.saving") : t("common.save")}
              </button>
              <button
                type="button"
                className="wb-icon-button"
                title={t("wb.reload")}
                onClick={() => requestReload(doc.id)}
              >
                <Icon name="refresh" />
              </button>
              <button
                type="button"
                className="wb-icon-button"
                title={t("wb.compareTitle")}
                onClick={() => onCompare(doc.path)}
              >
                <Icon name="diff" />
              </button>
            </div>
          </div>

          {(doc.remoteHash || doc.sync === "conflict") && dismissedConflict !== doc.id && (
            <div className="wb-banner is-warning" role="alert">
              <div>
                <strong>{t("wb.remoteChanged")}</strong>
                <span>{t("wb.remoteChangedHint")}</span>
              </div>
              <div className="wb-banner-actions">
                <button type="button" className="btn" onClick={() => void reloadDoc(doc.id)}>
                  {t("wb.reload")}
                </button>
                <button type="button" className="btn is-primary" onClick={() => void save(true)}>
                  {t("wb.overwrite")}
                </button>
                <button type="button" className="btn" onClick={() => setDismissedConflict(doc.id)}>
                  {t("wb.keepEditing")}
                </button>
              </div>
            </div>
          )}

          {doc.draftState === "failed" && doc.content !== doc.savedContent && (
            <div className="wb-banner is-error" role="alert">
              <div>
                <strong>{t("wb.draftNotStored")}</strong>
                <span>
                  {doc.draftError
                    ? t("wb.draftFailedHint", { error: doc.draftError })
                    : t("wb.draftFailedGeneric")}
                </span>
              </div>
              <div className="wb-banner-actions">
                <button type="button" className="btn" onClick={() => void retryDraft(doc.id)}>
                  {t("wb.retry")}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (navigator.clipboard) void navigator.clipboard.writeText(doc.content);
                  }}
                >
                  {t("wb.copyContent")}
                </button>
              </div>
            </div>
          )}

          {doc.error && doc.sync === "failed" && (
            <div className="wb-banner is-error" role="alert">
              <span>{t("wb.saveFailed", { error: doc.error })}</span>
              <button type="button" className="btn" onClick={() => void save()}>
                {t("wb.refresh")}
              </button>
            </div>
          )}

          {doc.draftRestored && (
            <div className="wb-banner is-info">
              <span>{t("wb.draftRestored")}</span>
            </div>
          )}

          {/* A draft written against another server identity is kept, not
              applied. Without this line the only hint was the count in the
              header, which is easy to miss after a host change. */}
          {doc.error && doc.sync === "synced" && (
            <div className="wb-banner is-warning" role="status">
              <span>{doc.error}</span>
              <button type="button" className="btn" onClick={() => setDraftsOpen(true)}>
                {t("wb.drafts")}
              </button>
            </div>
          )}

          <CodeEditor
            key={doc.id}
            doc={doc}
            dark={dark}
            fontSize={bufferFontSize}
            onChange={(content) => updateDoc(doc.id, content)}
            onSave={() => void save()}
            onRevealed={() => clearReveal(doc.id)}
          />
        </>
      )}

      {closing && (
        <ModalDialog
          open
          role="alertdialog"
          contentClassName="confirm-dialog"
          onClose={() => setClosing(null)}
        >
          <div className="dialog-header">{t("wb.dirtyCloseTitle")}</div>
          <div className="dialog-body confirm-dialog-body">
            <p>
              {t("wb.dirtyCloseBody", {
                path: docs.find((item) => item.id === closing)?.path ?? "",
              })}
            </p>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={() => setClosing(null)}>
              {t("common.cancel")}
            </button>
            {docs.find((item) => item.id === closing)?.draftState === "failed" && (
              <button
                type="button"
                className="btn is-danger"
                onClick={() => {
                  const id = closing;
                  setClosing(null);
                  void closeDoc(id, true);
                }}
              >
                {t("wb.discardAndClose")}
              </button>
            )}
            <button
              type="button"
              className="btn is-primary"
              onClick={() => {
                const id = closing;
                setClosing(null);
                // Closing only succeeds once the buffer is on disk; when it
                // does not, the tab stays and its banner explains why.
                void closeDoc(id);
              }}
            >
              {t("wb.close")}
            </button>
          </div>
        </ModalDialog>
      )}
      {reloading && (
        <ModalDialog
          open
          role="alertdialog"
          contentClassName="confirm-dialog"
          onClose={() => setReloading(null)}
        >
          <div className="dialog-header">{t("wb.dirtyReloadTitle")}</div>
          <div className="dialog-body confirm-dialog-body">
            <p>
              {t("wb.dirtyReloadBody", {
                path: docs.find((item) => item.id === reloading)?.path ?? "",
              })}
            </p>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={() => setReloading(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn is-danger"
              onClick={() => {
                const id = reloading;
                setReloading(null);
                void reloadDoc(id);
              }}
            >
              {t("wb.dirtyReloadConfirm")}
            </button>
          </div>
        </ModalDialog>
      )}
    </section>
  );
}
