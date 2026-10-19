import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { memo, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { t as translateMsg, type Translate } from "../../i18n";
import { FILER_OPEN_WITH_KEY } from "../../persistKeys";
import { IS_WINDOWS } from "../../platform";
import type { FileEntry, ThemeMode } from "../../types";
import { FileIcon } from "../FileIcon";
import { FilerEntryKind, TransferState } from "./filerTypes";

/** Pointer travel before a press on an entry turns into a drag out. */
export const DRAG_OUT_THRESHOLD = 5;

/**
 * Where a drag currently is, in CSS pixels, so it can be compared with the
 * panel's own `getBoundingClientRect()`.
 *
 * Tauri types the position as physical, but only Windows measures it that
 * way: wry reads the client point from `ScreenToClient`. macOS passes
 * AppKit's `draggingLocation` and Linux the widget coordinates of GTK's
 * `drag-motion` straight through, and both of those are already logical
 * points. Dividing them by the device pixel ratio put every drop at half its
 * real position, which on a Retina display is far to the left of the Filer —
 * the panel never saw a drop and nothing was ever uploaded.
 */
export const dropPoint = (position: PhysicalPosition): { x: number; y: number } =>
  IS_WINDOWS ? position.toLogical(window.devicePixelRatio) : position;

/** Footer wording per transfer kind and state; see `TransferState`. */
export const transferLabels = (
  t: Translate,
): Record<TransferState["kind"], Record<TransferState["status"], string>> => ({
  upload: {
    running: t("filer.tr.upload.running"),
    complete: t("filer.tr.upload.complete"),
    error: t("filer.tr.upload.error"),
    cancelled: t("filer.tr.upload.cancelled"),
  },
  download: {
    running: t("filer.tr.download.running"),
    complete: t("filer.tr.download.complete"),
    error: t("filer.tr.download.error"),
    cancelled: t("filer.tr.download.cancelled"),
  },
  sync: {
    running: t("filer.tr.sync.running"),
    complete: t("filer.tr.sync.complete"),
    error: t("filer.tr.sync.error"),
    cancelled: t("filer.tr.sync.cancelled"),
  },
  copy: {
    running: t("filer.tr.copy.running"),
    complete: t("filer.tr.copy.complete"),
    error: t("filer.tr.copy.error"),
    cancelled: t("filer.tr.copy.cancelled"),
  },
  stage: {
    running: t("filer.tr.stage.running"),
    complete: t("filer.tr.stage.complete"),
    error: t("filer.tr.stage.error"),
    cancelled: t("filer.tr.stage.cancelled"),
  },
});

/**
 * One file row, memoised so a panel re-render that nothing on the row
 * depends on — a transfer footer tick, a drag-over verdict, another row
 * being selected — skips every row instead of rebuilding their JSX, titles
 * and dates. Only primitive/stable props cross this boundary; the callbacks
 * come from useStableCallback in the panel.
 */
export const FilerRow = memo(function FilerRow({
  entry,
  selected,
  draggingOut,
  theme,
  onSelect,
  onActivate,
  onPointerDown,
  onPointerMove,
  onContextMenu,
}: {
  entry: FileEntry;
  selected: boolean;
  draggingOut: boolean;
  theme: ThemeMode;
  onSelect: (path: string, event: MouseEvent) => void;
  onActivate: (entry: FileEntry) => void;
  onPointerDown: (entry: FileEntry, event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu: (event: MouseEvent, entry: FileEntry) => void;
}) {
  const kind = entryKind(entry);
  return (
    <div
      className={`row filer-entry is-${kind}${selected ? " is-active" : ""}${draggingOut ? " is-dragging-out" : ""}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => onSelect(entry.path, event)}
      onPointerDown={(event) => onPointerDown(entry, event)}
      onPointerMove={onPointerMove}
      onDoubleClick={() => onActivate(entry)}
      onContextMenu={(event) => onContextMenu(event, entry)}
      title={entryTitle(entry)}
    >
      <FilerEntryIcon name={entry.name} isDir={entry.isDir} theme={theme} />
      <span className="row-label">{entry.name}</span>
      {/* A folder has no size of its own, the way the dual-pane rows show it. */}
      <span className="filer-col-size row-meta">
        {entry.isDir ? "—" : formatBytes(entry.size)}
      </span>
      <span className="filer-col-date row-meta">{formatDate(entry.modified)}</span>
    </div>
  );
});

export const FilerEntryIcon = memo(function FilerEntryIcon({
  name,
  isDir,
  theme,
}: {
  name: string;
  isDir: boolean;
  theme: ThemeMode;
}) {
  return (
    <span className="filer-icon">
      <FileIcon name={name} isDir={isDir} theme={theme} />
    </span>
  );
});

/** Applications the user has opened files with, most recent first. */
export const OPEN_WITH_KEY = FILER_OPEN_WITH_KEY;

export const OPEN_WITH_LIMIT = 6;

export function loadOpenWithApps(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_WITH_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((app): app is string => typeof app === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberOpenWithApp(app: string): string[] {
  const apps = [app, ...loadOpenWithApps().filter((known) => known !== app)];
  const kept = apps.slice(0, OPEN_WITH_LIMIT);
  try {
    localStorage.setItem(OPEN_WITH_KEY, JSON.stringify(kept));
  } catch {
    // Storage full or unavailable: the menu still works for this session.
  }
  return kept;
}

/** `/Applications/Visual Studio Code.app` → `Visual Studio Code`. */
export function appDisplayName(app: string): string {
  const base = localFileName(app);
  return base.replace(/\.(app|exe)$/i, "");
}

export function remoteParent(path: string): string {
  if (path === "/" || !path.includes("/")) return "/";
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function joinRemote(base: string, name: string): string {
  if (base.endsWith("/")) return `${base}${name}`;
  return `${base}/${name}`;
}

export function localFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "upload.bin";
}

export function joinLocal(base: string, name: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

/** One stop of a breadcrumb trail: what it shows and where it leads. */
export interface PathSegment {
  label: string;
  target: string;
}

/**
 * The ancestors of `path`, outermost first, the way a file manager's address
 * bar shows them: `/var/log/nginx` becomes `/`, `var`, `log`, `nginx`, and
 * `C:\Users\me` becomes `C:`, `Users`, `me`. The Windows drives root is not
 * a real path and has no ancestors, so it yields nothing; the panel draws no
 * trail for it either.
 */
export function pathSegments(path: string): PathSegment[] {
  if (!path || path === "This PC") return [];
  const windows = path.includes("\\");
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const segments: PathSegment[] = [];
  // A POSIX root is a segment of its own, the way every breadcrumb bar draws
  // it; a Windows drive already carries its own root inside the first part.
  if (!windows && path.startsWith("/")) segments.push({ label: "/", target: "/" });
  let target = windows ? "" : "/";
  for (const part of parts) {
    target = windows
      ? target === ""
        ? part
        : `${target}\\${part}`
      : `${target === "/" ? "" : target}/${part}`;
    segments.push({ label: part, target });
  }
  return segments;
}

export function pickedPaths(picked: string | string[] | null): string[] {
  if (Array.isArray(picked)) return picked;
  return typeof picked === "string" ? [picked] : [];
}

export function entryKind(entry: FileEntry): FilerEntryKind {
  if (entry.isSymlink) return "symlink";
  return entry.isDir ? "directory" : "file";
}

export function entryKindLabel(kind: FilerEntryKind): string {
  if (kind === "directory") return translateMsg("filer.kindFolder");
  if (kind === "symlink") return translateMsg("filer.kindLink");
  return translateMsg("filer.kindFile");
}

export function entryTitle(entry: FileEntry): string {
  const kind = entryKind(entry);
  const attributes = [entryKindLabel(kind)];
  if (!entry.isDir) attributes.push(formatBytes(entry.size));
  if (entry.permissions !== null) {
    attributes.push(
      translateMsg("filer.mode", {
        mode: (entry.permissions & 0o7777).toString(8).padStart(4, "0"),
      }),
    );
  }
  if (entry.owner) {
    attributes.push(entry.group ? `${entry.owner}:${entry.group}` : entry.owner);
  }
  return `${entry.path}\n${attributes.join(" · ")}`;
}

export function formatEntrySummary(entries: FileEntry[]): string {
  let folders = 0;
  let files = 0;
  let links = 0;
  for (const entry of entries) {
    const kind = entryKind(entry);
    if (kind === "directory") folders += 1;
    else if (kind === "symlink") links += 1;
    else files += 1;
  }

  const parts = [
    folders > 0
      ? translateMsg(folders === 1 ? "filer.oneFolder" : "filer.manyFolders", { count: folders })
      : "",
    files > 0
      ? translateMsg(files === 1 ? "filer.oneFile" : "filer.manyFiles", {
          count: files,
        })
      : "",
    links > 0
      ? translateMsg(links === 1 ? "filer.oneLink" : "filer.manyLinks", {
          count: links,
        })
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : translateMsg("filer.zeroItems");
}

export function formatDate(seconds: number | null): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
