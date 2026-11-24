import { useEffect, useRef, useState } from "react";
import {
  clearRevealLine,
  closeFileEditor,
  isFileEditorDirty,
  reloadFileEditor,
  saveFileEditor,
  useFileEditor,
} from "../fileEditor";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CodeEditor } from "../editor/CodeEditor";
import { IS_MAC } from "../platform";
import { chordLabel } from "../shortcuts";
import { useStore } from "../store";
import { isLightTheme } from "../types";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

export function FileEditorDialog() {
  const t = useT();
  const { target, file, content, busy, error, conflict, saved } = useFileEditor();
  const theme = useStore((state) => state.theme);
  const fontSize = useStore((state) => state.bufferFontSize);
  // The overwrite button is the one the reader just pressed, and it goes away
  // with the conflict it resolves: without this the browser moves focus to the
  // document body and the next keystrokes go nowhere.
  const [refocus, setRefocus] = useState(0);
  const wasConflicted = useRef(conflict);
  useEffect(() => {
    if (wasConflicted.current && !conflict) setRefocus((count) => count + 1);
    wasConflicted.current = conflict;
  }, [conflict]);
  if (!target) return null;
  const dirty = isFileEditorDirty(file, content);
  const storedPath = file?.path ?? target.path;
  const displayPath = target.sessionId
    ? storedPath
    : storedPath.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");
  /**
   * The editor's hint promises Ctrl+S saves. CodeMirror answers the chord from
   * the text alone, so a reader who just pressed Reload - or moved to the find
   * field - was pressing a key that did nothing. The dialog takes the chord
   * from everywhere the editor cannot.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key.toLowerCase() !== "s" || !(event.ctrlKey || event.metaKey)) return;
    if ((event.target as Element).closest(".cm-content")) return;
    event.preventDefault();
    void saveFileEditor();
  };
  return (
    <ModalDialog
      open
      dismissable={false}
      onClose={() => void closeFileEditor()}
      title={t("fileEditor.title")}
      contentClassName="file-editor-dialog"
      onKeyDown={onKeyDown}
    >
      <div className="file-editor-destination">
        <strong>{target.label}</strong>
        <code title={displayPath}>{displayPath}</code>
        {/* CodeMirror binds the platform modifier, not Ctrl, so the hint names
          the keys through the same formatter the menus use rather than a
          hardcoded "Ctrl+" that is wrong on a Mac build. */}
        <small>
          {t(target.sessionId ? "fileEditor.remoteHint" : "fileEditor.localHint", {
            save: chordLabel({
              ctrl: !IS_MAC,
              meta: IS_MAC,
              alt: false,
              shift: false,
              code: "KeyS",
            }),
            find: chordLabel({
              ctrl: !IS_MAC,
              meta: IS_MAC,
              alt: false,
              shift: false,
              code: "KeyF",
            }),
          })}
        </small>
      </div>
      {file && (
        <CodeEditor
          key={target.id}
          remember={false}
          doc={{ id: target.id, path: target.path, content, revealLine: target.line }}
          dark={!isLightTheme(theme)}
          fontSize={fontSize}
          onChange={(content) => useFileEditor.setState({ content, saved: false })}
          onSave={() => void saveFileEditor()}
          onRevealed={clearRevealLine}
          refocus={refocus}
        />
      )}
      {!file && (
        <p className="file-editor-empty">{t(busy ? "common.loading" : "fileEditor.textOnly")}</p>
      )}
      {error && (
        <div className="dialog-error" role="alert">
          {conflict && <strong>{t("fileEditor.conflict")} </strong>}
          {error}
        </div>
      )}
      <div className="dialog-footer">
        <span role="status">
          {busy
            ? t("common.loading")
            : dirty
              ? t("fileEditor.unsaved")
              : saved
                ? t("fileEditor.saved")
                : file
                  ? `${file.encoding} · ${file.eol.toUpperCase()}`
                  : ""}
        </span>
        <button className="btn" disabled={busy} onClick={() => void reloadFileEditor()}>
          {t("fileEditor.reload")}
        </button>
        <button className="btn" disabled={busy} onClick={() => void closeFileEditor()}>
          {t("common.close")}
        </button>
        {conflict && (
          <button
            className="btn is-warning"
            disabled={busy}
            onClick={() => void saveFileEditor(true)}
            title={t("fileEditor.overwriteHint")}
          >
            {t("fileEditor.overwrite")}
          </button>
        )}
        <button
          className="btn is-primary"
          disabled={busy || !dirty}
          onClick={() => void saveFileEditor()}
        >
          {t(target.sessionId ? "fileEditor.saveRemote" : "fileEditor.saveLocal")}
        </button>
      </div>
    </ModalDialog>
  );
}
