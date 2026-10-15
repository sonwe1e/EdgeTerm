import { createElement as h } from "react";
import { createRoot } from "react-dom/client";

import { FileBrowser } from "../../src/components/FtpPane";
import "../../src/styles.css";

// Isolated production-built page for the file-icon first-open measurement:
// the real FileBrowser component and stylesheet, a fixed listing whose rows
// need many different icons, and no app entry, Tauri runtime or IPC. The
// same fixture measures the baseline and candidate icon pipelines and is
// the reuse point for future compiler builds (#6).

const entries = [
  ["package.json", false],
  ["main.rs", false],
  ["app.tsx", false],
  ["style.css", false],
  ["docker-compose.yml", false],
  ["archive.tar.gz", false],
  ["backup.7z", false],
  ["notes.txt", false],
  ["query.sql", false],
  ["sconstruct", false],
  ["run.sh", false],
  ["cert.pem", false],
  ["table.csv", false],
  ["shape.blend", false],
  ["unknown.zzz", false],
  ["app.d.ts", false],
  ["app.spec.ts", false],
  ["routes.tsx", false],
  ["src", true],
  ["docs", true],
  ["build", true],
] as const;

const listing = entries.map(([name, isDir], index) => ({
  name,
  path: `/test/${name}`,
  isDir,
  isSymlink: false,
  size: index * 1000,
  modified: 1700000000 + index,
  permissions: null,
  owner: null,
  group: null,
}));

const noop = () => {};
const browserProps = {
  title: "icon probe",
  subtitle: "SFTP",
  path: "/test",
  draft: "/test",
  selected: null,
  loading: false,
  error: null,
  side: "remote" as const,
  draggingPath: null,
  dropHover: null,
  onItemPointerDown: noop,
  onItemPointerMove: noop,
  onItemPointerUp: noop,
  onDragCancel: noop,
  onDraftChange: noop,
  onOpenPath: noop,
  onHome: noop,
  onParent: noop,
  onRefresh: noop,
  onSelect: noop,
  onActivate: noop,
};

// Theme comes from the page URL (?theme=dark|light|serialx-...) so the same
// fixture serves the measurement and the light/dark screenshots.
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") ?? "dark";

const start = performance.now();
const root = createRoot(document.getElementById("root")!);
root.render(
  h(FileBrowser, { ...browserProps, entries: listing as never }),
);

// Done when EVERY rendered row's icon <img> exists AND has finished loading,
// then two more frames have passed (the paint boundary). The listing is
// below the virtualization threshold, so every entry renders exactly one
// row and one img: `expected` is the full entry count, not just the visible
// window. A broken URL surfaces as naturalWidth 0 and the driver fails on
// it; fewer imgs than entries means rows never rendered and the probe never
// settles.
const finish = () => {
  const imgs = document.querySelectorAll<HTMLImageElement>(".ftp-file-row img");
  if (imgs.length !== entries.length) return false;
  for (const img of imgs) {
    if (!img.complete || img.naturalWidth === 0) return false;
  }
  if (finish.frame === undefined) {
    // Two animation frames after the last img completes: the icons have
    // been through paint, not merely finished fetching.
    finish.frame = 0;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        finish.frame = -1;
      }),
    );
    return false;
  }
  if (finish.frame !== -1) return false;
  (window as unknown as { __probe: unknown }).__probe = {
    firstIconsMs: performance.now() - start,
    imgCount: imgs.length,
    broken: 0,
  };
  return true;
};
finish.frame = undefined as number | undefined;
const poll = () => {
  if (finish()) return;
  requestAnimationFrame(poll);
};
poll();
