/** Pure viewport geometry for the Filer's read-only image viewer. */
export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageView {
  scale: number;
  x: number;
  y: number;
  mode: "fit" | "custom";
}

const FIT_INSET = 24;
const MAX_SCALE = 8;

/** Fit without upscaling a small image beyond its real pixels. */
export function fitImageScale(image: ImageSize, viewport: ImageSize): number {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0)
    return 1;
  return Math.min(
    1,
    Math.max(1, viewport.width - FIT_INSET) / image.width,
    Math.max(1, viewport.height - FIT_INSET) / image.height,
  );
}

export function fitImageView(image: ImageSize, viewport: ImageSize): ImageView {
  return { scale: fitImageScale(image, viewport), x: 0, y: 0, mode: "fit" };
}

/**
 * The image stays centered while it fits. Once it overflows, pan is limited
 * to its edges — there are no blank strips to lose the image off-screen.
 */
export function clampImagePan(
  image: ImageSize,
  viewport: ImageSize,
  scale: number,
  x: number,
  y: number,
): Pick<ImageView, "x" | "y"> {
  const maxX = Math.max(0, (image.width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * scale - viewport.height) / 2);
  return {
    x: Math.max(-maxX, Math.min(x, maxX)),
    y: Math.max(-maxY, Math.min(y, maxY)),
  };
}

export function constrainImageView(
  view: ImageView,
  image: ImageSize,
  viewport: ImageSize,
): ImageView {
  if (view.mode === "fit") return fitImageView(image, viewport);
  return { ...view, ...clampImagePan(image, viewport, view.scale, view.x, view.y) };
}

/** Zoom around stage-centered cursor coordinates, then clamp the new bounds. */
export function zoomImageAt(
  view: ImageView,
  image: ImageSize,
  viewport: ImageSize,
  requestedScale: number,
  cursorX: number,
  cursorY: number,
): ImageView {
  const minScale = Math.min(0.1, fitImageScale(image, viewport));
  const scale = Math.max(minScale, Math.min(MAX_SCALE, requestedScale));
  const ratio = scale / view.scale;
  const position = clampImagePan(
    image,
    viewport,
    scale,
    cursorX - (cursorX - view.x) * ratio,
    cursorY - (cursorY - view.y) * ratio,
  );
  return { scale, ...position, mode: "custom" };
}

export function imageCanPan(image: ImageSize, viewport: ImageSize, scale: number): boolean {
  return image.width * scale > viewport.width || image.height * scale > viewport.height;
}
