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
 * The dash left for a size that cannot exist. Nothing else uses it: a folder's
 * size is not unknown, it is a category that has none and gets an empty cell,
 * and a time the listing withheld says "unknown" in words.
 */
const NO_VALUE = "—";

/**
 * The language a row's dates are written in: the interface language, which
 * setCurrentLanguage publishes on <html> for screen readers and the stylesheet
 * (see :lang(zh)), or nothing — Intl then uses the machine's own.
 */
export function rowLocale(): string | undefined {
  return document.documentElement.lang || undefined;
}

/** Size and capacity units above the byte, one power of 1024 apart. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Below a kilobyte a size is whole bytes; above it, one unit at a time. */
const BYTE_BASE = 1024;

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
  t,
  setSize,
  posInSet,
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
  /** Bound to the language, so a switch re-renders every row's labels. */
  t: Translate;
  /** The whole listing and this row's place in it: only a window is mounted,
      so the row has to say how long the list is, not how much of it is here. */
  setSize: number;
  posInSet: number;
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
      // Only a window of the list is mounted, so each row has to say how long
      // the whole list is: without these a 5000-file folder is announced as
      // "1 of 15", because 15 is all the DOM ever holds.
      aria-setsize={setSize}
      aria-posinset={posInSet}
      onMouseDown={(event) => onSelect(entry.path, event)}
      onPointerDown={(event) => onPointerDown(entry, event)}
      onPointerMove={onPointerMove}
      onDoubleClick={() => onActivate(entry)}
      onContextMenu={(event) => onContextMenu(event, entry)}
      title={entryTitle(entry, t)}
    >
      <FilerEntryIcon name={entry.name} isDir={entry.isDir} theme={theme} />
      {/* The icon is the only thing that tells a folder from a file, and it is
          an image with an empty alt: without this the row is read out as
          `nginx · · 10-20 14:32`, and the blank says nothing at all. It sits
          outside the label so it cannot change what the label reads as, and
          it is absolute so the grid gives it no track of its own. */}
      <span className="sr-only">{entryKindLabel(kind, t)}</span>
      <span className="row-label">{entry.name}</span>
      {/* A folder has no size of its own, the way the dual-pane rows show it.
          An empty cell is read as nothing, which is what an absent size is. */}
      <span className="filer-col-size row-meta">
        {entry.isDir ? "" : <FilerSize bytes={entry.size} />}
      </span>
      <span className="filer-col-date row-meta">
        <FilerDate modified={entry.modified} />
      </span>
    </div>
  );
});

/**
 * The number and its unit apart, so a row can give the unit a slot of its own.
 * Right-aligned on its own, `512 B` and `1.2 KB` end one character apart,
 * because the unit is what is flush right and the number is not.
 */
export function formatBytesParts(bytes: number): { value: string; unit: string } {
  const text = formatBytes(bytes);
  if (text === NO_VALUE) return { value: text, unit: "" };
  const cut = text.lastIndexOf(" ");
  return cut < 0
    ? { value: text, unit: "" }
    : { value: text.slice(0, cut), unit: text.slice(cut + 1) };
}

/** One size, with its unit in a slot every other size's unit also fits. */
const FilerSize = memo(function FilerSize({ bytes }: { bytes: number }) {
  const { value, unit } = formatBytesParts(bytes);
  return (
    <>
      {value}
      {/* The space is real text and it sits *outside* the unit's slot: inside
          it, the slot measured ` KB` at 3ch and ` B` at 2.2ch, so the numbers
          it exists to line up drifted apart by exactly the difference. It is
          real text at all because the row is read aloud and copied as one
          string, and `1023.9KB` is not how a size is said. */}
      {unit ? <>{" "}<span className="filer-size-unit">{unit}</span></> : null}
    </>
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

export function entryKindLabel(kind: FilerEntryKind, t: Translate = translateMsg): string {
  if (kind === "directory") return t("filer.kindFolder");
  if (kind === "symlink") return t("filer.kindLink");
  return t("filer.kindFile");
}

/**
 * A row's tooltip: the full path, its attributes, and — when the listing
 * carries one — the complete timestamp with seconds and the zone it was read
 * in. SFTP reports a UTC second count from a machine whose clock need not be
 * ours, and the row itself shows only `14:32` today, so this is where the
 * unambiguous moment lives.
 */
export function entryTitle(entry: FileEntry, t: Translate = translateMsg): string {
  const kind = entryKind(entry);
  // Labelled, not just separated by a middot: `文件 · 12.4 KB · 0644 ·
  // root:root` is only readable because you happen to know the order, so
  // every value carries its own label below.
  const attributes = [t("filer.tipType", { kind: entryKindLabel(kind, t) })];
  if (!entry.isDir) {
    // The exact count beside the rounded one: the column shows `1.2 KB`, and
    // the number of bytes is what comparing two files actually needs. A size
    // the listing could not report stays a dash in both places rather than
    // printing `NaN 字节`.
    const size = formatBytes(entry.size);
    const exact = Number.isFinite(entry.size) && entry.size >= 0;
    attributes.push(
      t("filer.tipSize", { size, bytes: exact ? entry.size.toLocaleString() : size }),
    );
  }
  if (entry.permissions !== null) {
    attributes.push(
      t("filer.mode", {
        mode: (entry.permissions & 0o7777).toString(8).padStart(4, "0"),
      }),
    );
  }
  if (entry.owner) {
    // `root:root` alone reads as one more path fragment; the label names it.
    attributes.push(
      t("filer.tipOwner", {
        owner: entry.group ? `${entry.owner}:${entry.group}` : entry.owner,
      }),
    );
  }
  const stamp = entryDateStamp(entry.modified);
  return stamp
    ? `${entry.path}\n${attributes.join(" · ")}\n${stamp}`
    : `${entry.path}\n${attributes.join(" · ")}`;
}

export function formatEntrySummary(
  entries: FileEntry[],
  t: Translate = translateMsg,
): string {
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
      ? t(folders === 1 ? "filer.oneFolder" : "filer.manyFolders", { count: folders })
      : "",
    files > 0
      ? t(files === 1 ? "filer.oneFile" : "filer.manyFiles", {
          count: files,
        })
      : "",
    links > 0
      ? t(links === 1 ? "filer.oneLink" : "filer.manyLinks", {
          count: links,
        })
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : t("filer.zeroItems");
}

/**
 * One formatter per locale. Building an `Intl.DateTimeFormat` is the expensive
 * part and a directory holds thousands of rows that all want the same shape;
 * `toLocaleDateString` with options rebuilds it per call, which is exactly
 * what this avoids.
 */
interface RowDateFormats {
  /** `14:32`, on a 23-hour cycle so every row's clock time is one width. */
  time: Intl.DateTimeFormat;
}
// The day and the year below are hand-built rather than formatted: the column
// is a fixed number of characters wide, and Intl would not only order
// `10/20/2025` differently in another locale, it would change that width
// with it. Only the clock time and the tooltip still need a locale.

const rowDateFormatsByLocale = new Map<string, RowDateFormats>();

function rowDateFormats(locale: string | undefined): RowDateFormats {
  const key = locale ?? "";
  const cached = rowDateFormatsByLocale.get(key);
  if (cached) return cached;
  const tags = locale ? [locale] : [];
  const built: RowDateFormats = {
    // A 23-hour cycle rather than the locale's own: `上午02:32` and `2:32 AM`
    // would make each row a different width, and the column has to be one.
    time: new Intl.DateTimeFormat(tags, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }),
  };
  rowDateFormatsByLocale.set(key, built);
  return built;
}

/** Local midnight that a timestamp falls on, for comparing whole days. */
function dayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

/** Local midnight of today, or of the day `offset` days from it. */
function dayOffset(now: Date, offset: number): number {
  return dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `10-20`: the day on its own, which is all a date needs inside its year. */
const isoDay = (date: Date): string =>
  `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** `2025-10-20`: once the year is not the one on screen, it has to be named. */
const isoDate = (date: Date): string => `${date.getFullYear()}-${isoDay(date)}`;

/** `+08:00` or `-05:00`: the zone this machine has read the moment into. */
function localOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const body = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad2(Math.floor(body / 60))}:${pad2(body % 60)}`;
}

/**
 * `未知` / `Unknown`, spoken rather than dashed: a dash says "no value the
 * way a folder has none", and this is not that — the listing was asked for a
 * moment and did not give one, which is worth saying out loud.
 */
function unknownDate(): string {
  return translateMsg("filer.dateUnknown");
}

/**
 * The two halves of a date cell: whatever leads it — today's word, the day,
 * the whole date — and the clock time trailing it, which only rows close
 * enough to care about carry. They are separate so the renderer can put them
 * in separate ink: lead `--fg-dim`, trailing time `--fg-faint`, so the newest
 * row in the column is not also the palest.
 */
export interface RowDateParts {
  value: string;
  time: string;
}

/**
 * The date a row shows, graded so the recent past reads at a glance: the word
 * for today with its clock time, the day and time for the rest of this year,
 * and the bare date beyond that. The day and the year are hand-built, not
 * formatted, so every locale prints the same number of characters — the column
 * is a fixed width and has to read as one.
 *
 * A missing time (`null`) is unknown, not absent, and says so; epoch 0 does
 * not look missing either — it is a real moment, 1970, and is shown as one.
 */
export function formatDateParts(
  seconds: number | null,
  locale?: string,
  now: Date = new Date(),
): RowDateParts {
  if (seconds === null || !Number.isFinite(seconds)) return { value: unknownDate(), time: "" };
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return { value: unknownDate(), time: "" };
  const time = rowDateFormats(locale).time.format(date);
  const day = dayStart(date);
  const today = dayOffset(now, 0);
  // Today is the one day that earns a word: it is the row a user scans for,
  // and a bare `14:32` is the same shape as the `10-20` on the rows beside it.
  if (day === today) return { value: translateMsg("filer.dateToday"), time };
  // A server whose clock runs ahead dates files in the future. Those fall back
  // to a plain day rather than printing a moment that has not happened yet;
  // the tooltip still carries the whole timestamp, zone and all.
  if (day > today || date.getFullYear() === now.getFullYear()) {
    return { value: isoDay(date), time };
  }
  return { value: isoDate(date), time: "" };
}

export function formatDate(
  seconds: number | null,
  locale?: string,
  now: Date = new Date(),
): string {
  const parts = formatDateParts(seconds, locale, now);
  return parts.time ? `${parts.value} ${parts.time}` : parts.value;
}

/**
 * A whole moment for the tooltip: `修改时间：2025-10-20 14:32:08 UTC+08:00`.
 * SFTP hands over a bare count of seconds since the epoch with no zone at
 * all, and the server's clock is not necessarily this machine's, so the number
 * on its own could lie by hours: this names the zone that read it.
 */
export function entryDateStamp(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  // "This device" is the part that has to be said, not just the zone: a remote
  // listing's mtime carries no zone of its own, so naming +08:00 alone leaves
  // it looking like the server's time. It is this machine's reading of it.
  return translateMsg("filer.dateStamp", {
    moment: `${isoDate(date)} ${clock}`,
    zone: `UTC${localOffset(date)}`,
  });
}

/** One row's date, the leading part in one ink and the trailing time in another. */
const FilerDate = memo(function FilerDate({ modified }: { modified: number | null }) {
  const parts = formatDateParts(modified, rowLocale());
  return (
    <>
      <span className="filer-date-value">{parts.value}</span>
      {/* Space before the time is inside the span so the cell is read aloud as
          one string and not as two words run together. */}
      {parts.time ? <span className="filer-date-time">{` ${parts.time}`}</span> : null}
    </>
  );
});

/**
 * One decimal in every unit above the byte, so `9.8 KB` and `1023.9 KB` are
 * the widest a size can be and no row prints fewer characters than another:
 * the column is a fixed number of characters wide and reads as a column.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NO_VALUE;
  if (bytes < BYTE_BASE) return `${Math.round(bytes)} B`;
  let unit = 1;
  let value = bytes / BYTE_BASE;
  while (unit < BYTE_UNITS.length - 1 && value >= BYTE_BASE) {
    value /= BYTE_BASE;
    unit += 1;
  }
  // Rounding to one decimal can carry a value into the next unit: 1023.96 KB
  // is 1.0 MB, and printing it as 1024.0 KB both overstates the size and
  // breaks the width the column counts on.
  if (unit < BYTE_UNITS.length - 1 && Math.round(value * 10) / 10 >= BYTE_BASE) {
    value /= BYTE_BASE;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
