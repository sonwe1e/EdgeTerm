import { closeFileEditor, reloadFileEditor, saveFileEditor, useFileEditor } from "../fileEditor";
import { CodeEditor } from "../workbench/CodeEditor";
import { useStore } from "../store";
import { isLightTheme } from "../types";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

export function FileEditorDialog() {
  const t = useT();
  const { target, file, content, busy, error, conflict, saved } = useFileEditor();
  const theme = useStore((state) => state.theme);
  const fontSize = useStore((state) => state.bufferFontSize);
  if (!target) return null;
  const dirty = file && content !== file.content.replace(/\r\n?/g, "\n");
  const storedPath = file?.path ?? target.path;
  const displayPath = target.sessionId
    ? storedPath
    : storedPath.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");
  return (
    <ModalDialog
      open
      dismissable={false}
      onClose={() => void closeFileEditor()}
      title={t("fileEditor.title")}
      contentClassName="file-editor-dialog"
    >
      <div className="file-editor-destination">
        <strong>{target.label}</strong>
        <code title={displayPath}>{displayPath}</code>
        <small>{t(target.sessionId ? "fileEditor.remoteHint" : "fileEditor.localHint")}</small>
      </div>
      {file && (
        <CodeEditor
          key={target.id}
          remember={false}
          doc={{ id: target.id, path: target.path, content, revealLine: null }}
          dark={!isLightTheme(theme)}
          fontSize={fontSize}
          onChange={(content) => useFileEditor.setState({ content, saved: false })}
          onSave={() => void saveFileEditor()}
          onRevealed={() => {}}
        />
      )}
      {!file && (
        <p className="file-editor-empty">{t(busy ? "wb.loading" : "fileEditor.textOnly")}</p>
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
            ? t("wb.loading")
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
        <button
          className="btn is-primary"
          disabled={busy || !file || !dirty}
          onClick={() => void saveFileEditor()}
        >
          {t(target.sessionId ? "fileEditor.saveRemote" : "fileEditor.saveLocal")}
        </button>
      </div>
    </ModalDialog>
  );
}
