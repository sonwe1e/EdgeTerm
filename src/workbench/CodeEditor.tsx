import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../useT";
import type { EditorDoc } from "./types";
import type { EditorHandle } from "./codemirror";

/**
 * Hosts one CodeMirror view. The module is imported on mount, so opening the
 * workbench without opening a file never pays for the editor bundle.
 */
export function CodeEditor({
  doc,
  dark,
  fontSize,
  onChange,
  onSave,
  onRevealed,
}: {
  doc: EditorDoc;
  dark: boolean;
  fontSize: number;
  onChange: (content: string) => void;
  onSave: () => void;
  onRevealed: () => void;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const applying = useRef(false);
  const callbacks = useRef({ onChange, onSave, onRevealed });
  callbacks.current = { onChange, onSave, onRevealed };

  // Built once per document: the parent remounts this component with a new
  // key when the file changes. Theme, size and content are applied by the
  // effects below without rebuilding the view.
  // The cleanup must run while the DOM node still exists: a passive effect's
  // cleanup runs after React removed the node, and CodeMirror's observer has
  // by then reset the DOM selection, which would overwrite the saved one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one view per doc.id
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    setReady(false);
    setFailed(null);
    void import("./codemirror")
      .then((module) =>
        module.createCodeEditor({
          parent: element,
          docId: doc.id,
          doc: doc.content,
          path: doc.path,
          dark,
          fontSize,
        }),
      )
      .then((created) => {
        if (disposed) {
          created.discard();
          return;
        }
        created.setCallbacks({
          onChange: (content) => {
            if (!applying.current) callbacks.current.onChange(content);
          },
          onSave: () => callbacks.current.onSave(),
        });
        handle.current = created;
        setReady(true);
        if (doc.revealLine) {
          created.revealLine(doc.revealLine);
          callbacks.current.onRevealed();
        } else {
          // Switching tabs moves focus to the tab element; without this the
          // editor is visible but Ctrl+Z/typing go nowhere until it is clicked.
          created.focus();
        }
      })
      .catch((error) => {
        if (!disposed) setFailed(String(error));
      });
    return () => {
      disposed = true;
      handle.current?.destroy();
      handle.current = null;
    };
    // The parent remounts this component when the document changes (key),
    // so the view is built once per file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  // Content replaced from the server (reload) or by a restored draft: write
  // it into the view without reporting it as a user edit. The handle rebuilds
  // the document state, so the undo history cannot reach across the reload.
  useEffect(() => {
    const current = handle.current;
    if (!current || !ready) return;
    if (current.view.state.doc.toString() === doc.content) return;
    applying.current = true;
    current.setContent(doc.content);
    applying.current = false;
  }, [doc.content, ready]);

  useEffect(() => {
    if (!ready) return;
    handle.current?.setTheme(dark, fontSize);
  }, [dark, fontSize, ready]);

  useEffect(() => {
    if (!ready || !doc.revealLine) return;
    handle.current?.revealLine(doc.revealLine);
    onRevealed();
  }, [doc.revealLine, ready, onRevealed]);

  return (
    <div className="wb-editor-host">
      <div className="wb-editor-mount" ref={host} aria-label={doc.path} />
      {!ready && !failed && (
        <div className="wb-editor-loading">{t("wb.loading")}</div>
      )}
      {failed && (
        <div className="wb-editor-loading" role="alert">
          {failed}
        </div>
      )}
    </div>
  );
}
