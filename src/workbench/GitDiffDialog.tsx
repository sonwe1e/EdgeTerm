import { useEffect, useState } from "react";
import { errorText } from "../errorInfo";
import { ModalDialog } from "../components/ModalDialog";
import { useT } from "../useT";
import * as wb from "./api";
import type { DiffText } from "./types";

export function GitDiffDialog({
  sessionId,
  root,
  path,
  onClose,
}: {
  sessionId: string | null;
  root: string;
  path: string;
  onClose: () => void;
}) {
  const t = useT();
  const [diff, setDiff] = useState<DiffText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    if (!sessionId) {
      setError(t("wb.noSession"));
      setLoading(false);
      return () => {
        live = false;
      };
    }
    void wb
      .gitDiff(sessionId, root, path)
      .then((found) => {
        if (live) {
          setDiff(found);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (live) {
          setError(errorText(failure));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [sessionId, root, path, t]);

  return (
    <ModalDialog open onClose={onClose} ariaLabel={t("wb.diff")} contentClassName="wb-diff-dialog">
      <div className="wb-dialog-header">
        <strong>{t("wb.diff")}</strong>
        <code>{path}</code>
        <button
          type="button"
          className="wb-icon-button"
          aria-label={t("wb.close")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {loading && <p className="wb-dialog-note">{t("wb.loading")}</p>}
      {error && <p className="wb-dialog-error">{error}</p>}
      {diff && !error && (
        <>
          {diff.text.trim() === "" ? (
            <p className="wb-dialog-note">{t("wb.noDiff")}</p>
          ) : (
            <pre className="wb-diff-text">
              {diff.text.split("\n").map((line, index) => (
                <span
                  key={index}
                  className={
                    line.startsWith("+")
                      ? "is-add"
                      : line.startsWith("-")
                        ? "is-del"
                        : line.startsWith("@@")
                          ? "is-hunk"
                          : line.startsWith("diff ") || line.startsWith("index ")
                            ? "is-meta"
                            : ""
                  }
                >
                  {line || " "}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
          {diff.truncated && <p className="wb-dialog-note">{t("wb.diffTruncated")}</p>}
        </>
      )}
    </ModalDialog>
  );
}
