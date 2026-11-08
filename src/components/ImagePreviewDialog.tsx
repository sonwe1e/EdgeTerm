import { useEffect, useState } from "react";

import { previewImageFile } from "../api";
import { errorText } from "../errorInfo";
import { imagePreviewMime, type ImagePreviewTarget } from "../imagePreview";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  target: ImagePreviewTarget;
  onClose: () => void;
}

const MAX_SIDE = 16_384;
const MAX_PIXELS = 32_000_000;

/** A one-shot, read-only preview. No external-editor copy or upload watcher. */
export function ImagePreviewDialog({ target, onClose }: Props) {
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSource(null);
    setError(null);
    setLoading(true);

    async function load() {
      try {
        const mime = imagePreviewMime(target.name);
        if (!mime) throw new Error(t("imagePreview.decodeFailed"));
        const bytes = await previewImageFile(target.sessionId, target.path);
        if (!active) return;
        // The binary comes from a raw IPC response, not a base64/string URL.
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mime }));
        setSource(objectUrl);
      } catch (reason) {
        if (active) {
          setError(errorText(reason));
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    // In-flight reads are ignored after retry, source switch or close. Old
    // Blob URLs are always revoked, including if decode itself fails.
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target.id, target.name, target.path, target.sessionId, attempt, t]);

  return (
    <ModalDialog
      open
      onClose={onClose}
      title={t("imagePreview.title")}
      contentClassName="image-preview-dialog"
    >
      <div className="image-preview-destination">
        <strong title={target.name}>{target.name}</strong>
        <code title={target.path}>{target.path}</code>
        <small>{t("imagePreview.readOnly")}</small>
      </div>
      <div className="image-preview-stage">
        {loading && <p role="status">{t("imagePreview.loading")}</p>}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        {source && !error && (
          <img
            src={source}
            alt={target.name}
            onError={() => setError(t("imagePreview.decodeFailed"))}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (
                width === 0 ||
                height === 0 ||
                width > MAX_SIDE ||
                height > MAX_SIDE ||
                width * height > MAX_PIXELS
              )
                setError(t("imagePreview.dimensionsExceeded"));
            }}
          />
        )}
      </div>
      <div className="dialog-footer">
        {error && (
          <button className="btn" type="button" onClick={() => setAttempt((value) => value + 1)}>
            {t("imagePreview.retry")}
          </button>
        )}
        <button className="btn" type="button" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </ModalDialog>
  );
}
