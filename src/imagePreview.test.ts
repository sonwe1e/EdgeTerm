import { describe, expect, it } from "vitest";
import { imagePreviewMime } from "./imagePreview";

describe("Filer image-preview allowlist", () => {
  it("accepts only familiar image formats, case insensitively", () => {
    expect(imagePreviewMime("frame.PNG")).toBe("image/png");
    expect(imagePreviewMime("photo.jpeg")).toBe("image/jpeg");
    expect(imagePreviewMime("image.jpg")).toBe("image/jpeg");
    expect(imagePreviewMime("animated.GIF")).toBe("image/gif");
    expect(imagePreviewMime("capture.webp")).toBe("image/webp");
  });

  it("does not preview executable, extensionless or spoofed files", () => {
    for (const name of ["image.svg", "image.html", "image.png.html", "png", ".png", "a.txt"])
      expect(imagePreviewMime(name)).toBeNull();
  });
});
