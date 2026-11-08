/** The Filer's deliberately narrow, non-executable image allowlist. */
export function imagePreviewMime(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

export interface ImagePreviewTarget {
  /** Each open gets a fresh identity so a late response cannot replace it. */
  id: string;
  tabId: string | null;
  sessionId: string | null;
  path: string;
  name: string;
}
