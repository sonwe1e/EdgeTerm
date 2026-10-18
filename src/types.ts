import type * as Wire from "./bindings";
import type { Translate } from "./i18n";

export type SessionKind = Wire.SessionKind;
/** What the Backspace key sends; see `SessionProfile.backspace`. */
export type BackspaceKey = Wire.BackspaceKey;

/**
 * File-transfer sessions with no interactive terminal: they open the dual-pane
 * file manager instead of an xterm, and are skipped by the Sender, search, and
 * terminal-only wiring. FTP speaks its own protocol; SFTP rides an SSH
 * transport but is likewise browse-and-transfer only.
 */
export function isFileSession(kind: SessionKind): boolean {
  return kind === "ftp" || kind === "sftp";
}

/** Sessions that ride an SSH transport, and so can be or use a jump host. */
export function isSshTransport(kind: SessionKind): boolean {
  return kind === "ssh" || kind === "sftp";
}

/**
 * The interface palettes. Each one is a `:root[data-theme=...]` block in
 * styles.css plus an entry in the xterm, search and semantic palettes; the
 * serialX pair is ported from that project's own workbench design system.
 */
export const THEME_MODES = [
  "dark",
  "light",
  "serialx-dark",
  "serialx-light",
] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

/** Display names for View → Theme, in the order the menu lists them. */
export const themeLabels = (t: Translate): Record<ThemeMode, string> => ({
  dark: t("theme.dark"),
  light: t("theme.light"),
  "serialx-dark": t("theme.serialxDark"),
  "serialx-light": t("theme.serialxLight"),
});

/**
 * True for the palettes drawn on paper. Anything that picks between a pair of
 * assets or blends a tint asks this instead of comparing against "light".
 */
export function isLightTheme(theme: ThemeMode): boolean {
  return theme === "light" || theme === "serialx-light";
}

/**
 * The two palettes ported from serialX. They bring that project's own
 * highlighter along (`serialxHighlight.ts`), so the semantic layer asks this
 * to decide which engine reads a line.
 */
export function isSerialxTheme(theme: ThemeMode): boolean {
  return theme === "serialx-dark" || theme === "serialx-light";
}

export type SessionProfile = Omit<Wire.SessionProfile_Deserialize, "id"> & { id: string };

/**
 * A user-defined folder in the Session panel. Groups belong to one session
 * kind and may nest under another group of the same kind.
 */
export type SessionGroup = Required<Wire.SessionGroup>;

export type SessionInfo = Required<Wire.SessionInfo>;

/** The legacy algorithms one SSH server was connected with (issue #60). */
export type LegacyAlgorithms = Wire.LegacyAlgorithms;

/** An SSH host whose key no longer matches the one recorded in known_hosts. */
export type HostKeyChange = Wire.HostKeyChange;

/**
 * A round of questions an SSH server asked while authenticating (RFC 4256's
 * keyboard-interactive, the usual carrier for MFA). The answers go back to
 * `answerAuthPrompt` under the same id and are never saved.
 */
export type AuthPrompt = Wire.AuthPrompt;

/** What open_session produced: a live session, or a decision for the user. */
export type OpenSessionOutcome = Exclude<Wire.OpenSessionOutcome, { status: "connected" }> |
  (Extract<Wire.OpenSessionOutcome, { status: "connected" }> & { info: SessionInfo });

export type FileEntry = Wire.FileEntry;

export type DirListing = Wire.DirListing;

export type SerialPortDesc = Wire.SerialPortDesc;

export type SessionState = "connecting" | "connected" | "closed" | "error";

export type LineEnding = "none" | "lf" | "crlf";

/**
 * Where a saved Sender command is listed: everywhere, for one session kind,
 * for a Session panel group (and everything nested in it), or for one saved
 * session. See `senderScope.ts` for how a tab's chain of scopes is resolved.
 */
export type CommandScope = Wire.CommandScope;

export type SavedCommand = Required<Wire.SavedCommand>;

/**
 * One export / import file (Session → Export / Import Data…). `settings` is
 * the frontend's own `AppSettings`, carried through the backend untouched;
 * passwords and passphrases are never part of a data file.
 */
export type AppData = Omit<Wire.AppData_Serialize, "profiles"> & { profiles: SessionProfile[] };

/** How many entries an export wrote or an import merged. */
export type DataSummary = Wire.DataSummary;

/**
 * One `Host` alias of an OpenSSH client configuration, resolved the way
 * `ssh alias` resolves it (Session → Import OpenSSH Config…).
 */
export type SshConfigEntry = Wire.SshConfigEntry_Serialize;

/** What an import of the file would bring in, for the dialog to choose from. */
export type SshConfigPreview = Wire.SshConfigPreview_Serialize;

export type SshImportSummary = Required<Wire.SshImportSummary>;

/** Colours used for session dots, mirroring WindTerm's per-session markers. */
export const SESSION_COLORS = [
  "#4ea1f3",
  "#3fb950",
  "#e3b341",
  "#f85149",
  "#bc8cff",
  "#39c5cf",
  "#ff7b72",
  "#a5d6ff",
  "#f0883e",
  "#db61a2",
  "#7ee787",
  "#6e8cff",
  "#2db89a",
  "#f0c36e",
  "#e56bce",
  "#d2a8ff",
];

export function randomSessionColor(): string {
  return SESSION_COLORS[Math.floor(Math.random() * SESSION_COLORS.length)];
}

export function colorForSession(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return SESSION_COLORS[hash % SESSION_COLORS.length];
}
