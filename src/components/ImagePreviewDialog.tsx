import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { previewImageFile } from "../api";
import { errorText } from "../errorInfo";
import { imagePreviewMime, type ImagePreviewTarget } from "../imagePreview";
import {
  clampImagePan,
  constrainImageView,
  fitImageView,
  imageCanPan,
  type ImageSize,
  type ImageView,
  zoomImageAt,
} from "../imagePreviewViewport";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  target: ImagePreviewTarget;
  onClose: () => void;
}

const MAX_SIDE = 16_384;
const MAX_PIXELS = 32_000_000;
const ZOOM_STEP = 1.25;
const EMPTY_VIEW: ImageView = { scale: 1, x: 0, y: 0, mode: "fit" };

interface DragStart {
  pointerId: number;
  clientX: number;
  clientY: number;
  panX: number;
  panY: number;
}

/** A read-only image canvas. No external-editor copy or upload watcher. */
export function ImagePreviewDialog({ target, onClose }: Props) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragStart | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 });
  const [view, setView] = useState<ImageView>(EMPTY_VIEW);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      setViewport((old) =>
        old.width === width && old.height === height ? old : { width, height },
      );
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(stage);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // Responsive resizing refits an image in Fit mode, but preserves the exact
  // zoom level (subject to edge clamping) after the user selects a custom size.
  useEffect(() => {
    if (imageSize) setView((current) => constrainImageView(current, imageSize, viewport));
  }, [imageSize, viewport]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !imageSize) return;
    // React's delegated wheel listener is passive in WebView2; native
    // passive:false is required for cursor-centered zoom without scrolling
    // the containing window while the cursor is over the image canvas.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const factor = Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.0025);
      setView((current) =>
        zoomImageAt(
          current,
          imageSize,
          viewport,
          current.scale * factor,
          event.clientX - rect.left - rect.width / 2,
          event.clientY - rect.top - rect.height / 2,
        ),
      );
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [imageSize, viewport]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSource(null);
    setError(null);
    setLoading(true);
    setImageSize(null);
    setView(EMPTY_VIEW);
    setDragging(false);
    dragRef.current = null;

    async function load() {
      try {
        const mime = imagePreviewMime(target.name);
        if (!mime) throw new Error(t("imagePreview.decodeFailed"));
        const bytes = await previewImageFile(target.sessionId, target.path);
        if (!active) return;
        // The binary comes from a raw IPC response, not a base64/string URL.
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
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

  const loaded = !!(source && imageSize && !error);
  const canPan = !!(imageSize && imageCanPan(imageSize, viewport, view.scale));

  const zoomAtCenter = (scale: number) => {
    if (!imageSize) return;
    setView((current) => zoomImageAt(current, imageSize, viewport, scale, 0, 0));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canPan) return;
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: view.x,
      panY: view.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !imageSize) return;
    setView((current) => ({
      ...current,
      ...clampImagePan(
        imageSize,
        viewport,
        current.scale,
        drag.panX + event.clientX - drag.clientX,
        drag.panY + event.clientY - drag.clientY,
      ),
      mode: "custom",
    }));
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      !imageSize ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    const key = event.key;
    if (key === "+" || key === "=") zoomAtCenter(view.scale * ZOOM_STEP);
    else if (key === "-" || key === "_") zoomAtCenter(view.scale / ZOOM_STEP);
    else if (key === "0") setView(fitImageView(imageSize, viewport));
    else if (key === "1") zoomAtCenter(1);
    else if (canPan && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
      const x = view.x + (key === "ArrowRight" ? -40 : key === "ArrowLeft" ? 40 : 0);
      const y = view.y + (key === "ArrowDown" ? -40 : key === "ArrowUp" ? 40 : 0);
      setView((current) => ({
        ...current,
        ...clampImagePan(imageSize, viewport, current.scale, x, y),
        mode: "custom",
      }));
    } else return;
    event.preventDefault();
  };

  return (
    <ModalDialog
      open
      onClose={onClose}
      title={t("imagePreview.title")}
      contentClassName="image-preview-dialog"
    >
      <div className="image-preview-destination">
        <div className="image-preview-file">
          <strong title={target.name}>{target.name}</strong>
          <code title={target.path}>{target.path}</code>
        </div>
        <small>{t("imagePreview.readOnly")}</small>
      </div>
      <div
        ref={stageRef}
        className={`image-preview-stage${canPan ? " is-pannable" : ""}${dragging ? " is-dragging" : ""}`}
        role="region"
        aria-label={t("imagePreview.viewport")}
        tabIndex={0}
        onKeyDown={onStageKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={stopDrag}
      >
        {(loading || (source && !imageSize && !error)) && (
          <p role="status">{t("imagePreview.loading")}</p>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        {source && !error && (
          <img
            src={source}
            alt={target.name}
            draggable={false}
            style={{
              visibility: imageSize ? "visible" : "hidden",
              width: imageSize?.width,
              height: imageSize?.height,
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
            onError={() => setError(t("imagePreview.decodeFailed"))}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (
                width === 0 ||
                height === 0 ||
                width > MAX_SIDE ||
                height > MAX_SIDE ||
                width * height > MAX_PIXELS
              ) {
                setError(t("imagePreview.dimensionsExceeded"));
              } else {
                setImageSize({ width, height });
                setView(fitImageView({ width, height }, viewport));
              }
            }}
          />
        )}
      </div>
      <div className="dialog-footer image-preview-footer">
        <div
          className="image-preview-toolbar"
          role="toolbar"
          aria-label={t("imagePreview.controls")}
        >
          <button
            className="btn image-preview-tool"
            type="button"
            disabled={!loaded}
            aria-label={t("imagePreview.zoomOut")}
            title={t("imagePreview.zoomOut")}
            onClick={() => zoomAtCenter(view.scale / ZOOM_STEP)}
          >
            −
          </button>
          <output className="image-preview-scale" aria-label={t("imagePreview.zoomLevel")}>
            {loaded ? `${Math.round(view.scale * 100)}%` : "—"}
          </output>
          <button
            className="btn image-preview-tool"
            type="button"
            disabled={!loaded}
            aria-label={t("imagePreview.zoomIn")}
            title={t("imagePreview.zoomIn")}
            onClick={() => zoomAtCenter(view.scale * ZOOM_STEP)}
          >
            +
          </button>
          <button
            className="btn image-preview-tool"
            type="button"
            disabled={!loaded}
            aria-pressed={loaded && view.mode === "custom" && view.scale === 1}
            onClick={() => zoomAtCenter(1)}
          >
            100%
          </button>
          <button
            className="btn image-preview-tool"
            type="button"
            disabled={!loaded}
            aria-pressed={loaded && view.mode === "fit"}
            onClick={() => imageSize && setView(fitImageView(imageSize, viewport))}
          >
            {t("imagePreview.fit")}
          </button>
        </div>
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
