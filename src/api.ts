import { commands, events } from "./bindings";
import type * as Wire from "./bindings";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { OutputConsumption } from "./outputFlow";
import { readTransferOptions } from "./transferSettings";

import type {
  AppData,
  AuthPrompt,
  DataSummary,
  DirListing,
  HostKeyChange,
  OpenSessionOutcome,
  SavedCommand,
  SerialPortDesc,
  SessionGroup,
  SessionProfile,
  SshConfigPreview,
  SshImportSummary,
  ThemeMode,
} from "./types";

export type StateEvent = Wire.StateEvent;

export type TransferProgress = Wire.TransferProgress;

export type TransferItem = Wire.TransferItem;
export type TransferOptions = Required<Wire.TransferOptions>;
export type FileTransfer = Omit<Wire.FileTransfer, "status" | "options"> & {
  status: "queued" | "running" | "pausing" | "paused" | "retrying" | "cancelling" | "cancelled" | "complete" | "error";
  options: TransferOptions;
};
export const transferFiles = (
  id: string, items: TransferItem[], onProgress: (progress: TransferProgress) => void,
  transfer = newTransferId(), options?: TransferOptions,
) => {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return invoke<void>("transfer_files", { id, items, transfer, options: options ?? readTransferOptions(), onProgress: channel });
};
export const listFileTransfers = () => invoke<FileTransfer[]>("list_file_transfers");
export const controlFileTransfer = (transfer: string, action: "pause" | "resume" | "retry" | "cancel" | "dismiss") =>
  invoke<void>("control_file_transfer", { transfer, action });
export const onFileTransfer = (callback: (job: FileTransfer) => void) =>
  listen<FileTransfer>("transfer:changed", ({ payload }) => callback(payload));
export const onFileTransferRemoved = (callback: (id: string) => void) =>
  listen<string>("transfer:removed", ({ payload }) => callback(payload));

// --- interrupted-transfer recovery -------------------------------------------

export type DiffMetadata = Wire.DiffMetadata;
export type DiffRow = Wire.DiffRow;
export type FileComparison = Wire.FileComparison;
export const compareFiles = (id: string, requestId: string, local: string, remote: string) =>
  commands.compareFiles(id, requestId, local, remote);
export const cancelFileDiff = (requestId: string) => commands.cancelFileDiff(requestId);

export interface ResourceMetrics {
  status: "ok" | "unsupported";
  cpuPercent: number | null; cpuStatus: string;
  memory: {usedBytes:number;totalBytes:number} | null; memoryStatus: string;
  capacity: {usedBytes:number;totalBytes:number;mount:string} | null; capacityStatus: string;
  diskReadBps:number | null; diskWriteBps:number | null; diskStatus:string;
  networkReceiveBps:number | null; networkSendBps:number | null; networkStatus:string;
  gpus: {index:number;name:string;utilization:number | null;usedBytes:number | null;totalBytes:number | null;temperature:number | null}[];
  gpuStatus: string;
}
export const sampleResources = (id:string,requestId:string) => invoke<ResourceMetrics>("sample_resources",{id,requestId});
export const cancelResourceSample = (requestId:string) => invoke<void>("cancel_resource_sample",{requestId});

/** One journal found on disk after a restart. */
export interface RecoverableTransfer {
  id: string;
  name: string;
  kind: "sftp" | "ftp" | null;
  endpoint: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  items: number;
  checkpoints: number;
  /** The directory exists but its journal cannot be attributed; only Discard is offered. */
  unrecognized: boolean;
}

/** Journals of transfers a restart interrupted; the recovery list. */
export const listRecoverableTransfers = () =>
  invoke<RecoverableTransfer[]>("list_recoverable_transfers");

/**
 * Resumes an interrupted transfer on an open session to the same endpoint.
 * Without a matching open session this fails with the server to connect to.
 * SFTP reuses authenticated SSH; FTP dials its own transfer connections.
 */
export const recoverTransfer = (
  transfer: string, onProgress: (progress: TransferProgress) => void,
) => {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return invoke<void>("recover_transfer", { transfer, onProgress: channel });
};

/** Deletes an interrupted transfer's journal; remote partials are left in place. */
export const discardRecoverableTransfer = (transfer: string) =>
  invoke<void>("discard_recoverable_transfer", { transfer });

export type ZmodemFileInfo = Wire.ZmodemFileInfo;

// --- profiles ---------------------------------------------------------------

export const listProfiles = () => commands.listProfiles();

export const saveProfile = (profile: SessionProfile) =>
  invoke<SessionProfile>("save_profile", { profile });

/** Saves a copy of a profile, stored credentials included. */
export const duplicateProfile = (id: string) =>
  invoke<SessionProfile>("duplicate_profile", { id });

/** Deletes a profile with its credentials and the Sender commands scoped to it. */
export const deleteProfile = (id: string) =>
  invoke<void>("delete_profile", { id });

// --- session groups ---------------------------------------------------------

export const listSessionGroups = () =>
  invoke<SessionGroup[]>("list_session_groups");

export const saveSessionGroup = (group: SessionGroup) =>
  invoke<SessionGroup>("save_session_group", { group });

/**
 * Deletes a group and its subgroups; profiles inside move to the deleted
 * group's parent, so callers must reload profiles afterwards.
 */
export const deleteSessionGroup = (id: string) =>
  invoke<void>("delete_session_group", { id });

// --- sender commands -------------------------------------------------------

export const listSenderCommands = () =>
  invoke<SavedCommand[]>("list_sender_commands");

export const saveSenderCommand = (command: SavedCommand) =>
  invoke<SavedCommand>("save_sender_command", { command });

export const deleteSenderCommand = (id: string) =>
  invoke<void>("delete_sender_command", { id });

// --- data export / import ---------------------------------------------------

/** Writes sessions, groups, Sender tags and `settings` to `path` (no secrets). */
export const exportAppData = (
  path: string,
  settings: unknown,
  exportedAt: string,
) => invoke<DataSummary>("export_app_data", { path, settings, exportedAt });

/** Parses a data file for preview; credentials in it are dropped by the backend. */
export const readAppData = (path: string) =>
  invoke<AppData>("read_app_data", { path });

/** Merges a file from `readAppData` into the saved data (same id replaces). */
export const importAppData = (data: AppData) =>
  invoke<DataSummary>("import_app_data", { data });

// --- OpenSSH config import --------------------------------------------------

/** `~/.ssh/config`, whether or not it exists; the open dialog starts there. */
export const defaultSshConfigPath = () =>
  invoke<string>("default_ssh_config_path");

/** Parses an OpenSSH client config and marks the aliases already saved. */
export const readSshConfig = (path: string) =>
  invoke<SshConfigPreview>("read_ssh_config", { path });

/** Saves the chosen aliases as SSH sessions under `groupId` (null: top level). */
export const importSshConfig = (
  path: string,
  aliases: string[],
  groupId: string | null,
) => invoke<SshImportSummary>("import_ssh_config", { path, aliases, groupId });

// --- public-key login setup --------------------------------------------------

export type KeySummary = Wire.KeySummary;
export type InstallReport = Wire.InstallReport;
export type KeyCheck = Wire.KeyCheck;
export type KeySetup = Wire.KeySetup;

/**
 * Reads a private key file for the setup dialog: its type, the public
 * `authorized_keys` line and the SHA-256 fingerprint. An encrypted key needs
 * its passphrase to be read at all.
 */
export const inspectPrivateKey = (path: string, passphrase?: string) =>
  commands.inspectPrivateKey(path, passphrase || null);

let keyCheckSerial = 0;

/** A fresh id for a cancellable public-key check; see `cancelKeyCheck`. */
export const newKeyCheckId = (): string =>
  `keycheck-${Date.now().toString(36)}-${++keyCheckSerial}`;

/**
 * The whole setup behind the dialog: install the key's public half over the
 * live session's SFTP, verify on a fresh connection that the key alone logs
 * in, and only then save the session with the new login. The result reports
 * each step, so an install that was not verified can be told apart from a
 * flow that never got that far.
 */
export const configurePublicKeyLogin = (
  sessionId: string,
  requestId: string,
  profileId: string,
  privateKeyPath: string,
  passphrase: string | null,
  comment?: string,
) =>
  commands.configurePublicKeyLogin(
    sessionId,
    requestId,
    profileId,
    privateKeyPath,
    passphrase,
    comment ?? null,
  );

/**
 * Stops the check running under `requestId`; the setup command ends with a
 * cancelled check and leaves the saved session alone.
 */
export const cancelKeyCheck = (requestId: string) =>
  commands.cancelKeyCheck(requestId);


// --- command history ---------------------------------------------------------

export type CommandHistoryEntry = Wire.CommandHistoryEntry;

export const listCommandHistory = () =>
  invoke<CommandHistoryEntry[]>("list_command_history");

export const recordCommand = (command: string, host: string) =>
  invoke<void>("record_command", { command, host });

export const deleteCommandHistory = (command: string) =>
  invoke<void>("delete_command_history", { command });

export const clearCommandHistory = () =>
  invoke<void>("clear_command_history");

// --- sessions ---------------------------------------------------------------

/**
 * Opens a session under an id the caller minted. `reuseSessionId` names a
 * session whose SSH connection this one should run on instead of dialling
 * and authenticating its own — how a duplicated tab reaches a server behind
 * MFA without a second challenge. A connection that is no longer up is
 * replaced according to the automatic reuse preference. Without an explicit
 * source, matching authenticated connections are reused when autoReuse is on.
 *
 * Terminal output streams back on the raw IPC channel created here: the
 * webview receives ArrayBuffers — one per coalesced batch of bytes, no
 * base64 detour — ready to feed straight into xterm.js. File sessions
 * (FTP, SFTP) never produce any.
 */
const outputConnections = new Map<string, { token: string; consumption: OutputConsumption }>();

export const openSession = (
  profile: SessionProfile,
  sessionId: string,
  onOutput: (bytes: Uint8Array, consumed: () => void) => void,
  reuseSessionId?: string,
  autoReuse = true,
) => {
  const output = new Channel<ArrayBuffer>();
  const outputToken = crypto.randomUUID();
  outputConnections.get(sessionId)?.consumption.dispose();
  const consumption = new OutputConsumption((consumed) =>
    invoke<void>("acknowledge_session_output", { token: outputToken, consumed }),
  );
  outputConnections.set(sessionId, { token: outputToken, consumption });
  output.onmessage = (data) => {
    if (outputConnections.get(sessionId)?.token !== outputToken) return;
    onOutput(new Uint8Array(data), consumption.receive(data.byteLength));
  };
  return invoke<OpenSessionOutcome>("open_session", {
    profile,
    sessionId,
    onOutput: output,
    outputToken,
    reuseSessionId: reuseSessionId ?? null,
    autoReuse,
  }).then((outcome) => {
    if (outcome.status !== "connected") retireOutput(sessionId, outputToken);
    return outcome;
  }, (error: unknown) => {
    retireOutput(sessionId, outputToken);
    throw error;
  });
};

function retireOutput(id: string, token?: string) {
  const current = outputConnections.get(id);
  if (!current || (token !== undefined && current.token !== token)) return;
  current.consumption.dispose();
  outputConnections.delete(id);
}

/** Records the key from a reported change as the host's only known key. */
export const acceptHostKey = (change: HostKeyChange) =>
  invoke<void>("accept_host_key", {
    host: change.host,
    port: change.port,
    publicKey: change.publicKey,
  });

/**
 * Answers one round of an SSH server's keyboard-interactive challenge for the
 * session still connecting behind it; `null` cancels the attempt. Nothing
 * typed here is stored.
 */
export const answerAuthPrompt = (id: string, responses: string[] | null) =>
  invoke<void>("answer_auth_prompt", { id, responses });

export const closeSession = (id: string) => {
  const token = outputConnections.get(id)?.token;
  return invoke<void>("close_session", { id }).then(() => {
    // A failed close must not strand a live backend by stopping its ACKs.
    // A late close response must not retire a newly reconnected stream.
    if (token !== undefined) retireOutput(id, token);
  });
};

/** Where a profile's recordings go when it names no folder of its own. */
export const defaultRecordingDir = () =>
  invoke<string>("default_recording_dir");

/** One installed font family, as `list_system_fonts` reports it. */
export type FontFamily = Wire.FontFamily;

/** Every family in the machine's font directories, sorted by name. */
export const listSystemFonts = () => invoke<FontFamily[]>("list_system_fonts");

/** The face fontconfig gives for `monospace`; null off Linux. */
export const systemMonospaceFamily = () =>
  invoke<string | null>("system_monospace_family");

export const writeSession = (id: string, data: string) =>
  invoke<void>("write_session", { id, data });

// Only the small metadata header is encoded. File/protocol payloads stay raw,
// including typed views with non-zero offsets (do not pass their whole buffer).
function binaryOptions(metadata: unknown) {
  return {
    headers: {
      "x-edgeterm-metadata": bytesToBase64(new TextEncoder().encode(JSON.stringify(metadata))),
    },
  };
}

export const writeSessionBytes = (id: string, bytes: Uint8Array) =>
  invoke<void>("write_session_bytes", bytes, binaryOptions({ id }));

export const resizeSession = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_session", { id, cols, rows });

// --- local file streaming for ZMODEM / XMODEM -------------------------------
// Bounded chunks so a transfer never holds a whole file in the WebView; used
// through terminalTransfer.ts by both protocols.

export const zmodemFileInfo = (path: string) =>
  invoke<ZmodemFileInfo>("zmodem_file_info", { path });

export const zmodemReadBytes = async (path: string, offset: number, length: number) =>
  new Uint8Array(await invoke<ArrayBuffer>("zmodem_read_bytes", { path, offset, length }));

export const zmodemCreateFile = (path: string) =>
  invoke<void>("zmodem_create_file", { path });

export const zmodemWriteBytes = (
  path: string,
  offset: number,
  bytes: Uint8Array,
) =>
  invoke<void>("zmodem_write_bytes", bytes, binaryOptions({ path, offset }));

export const zmodemFinishFile = (path: string, size: number) =>
  invoke<void>("zmodem_finish_file", { path, size });

// --- remote filesystem ------------------------------------------------------

export const sftpHome = (id: string) => invoke<string>("sftp_home", { id });

export const sftpList = (id: string, path: string) =>
  invoke<DirListing>("sftp_list", { id, path });

export const sftpMkdir = (id: string, path: string) =>
  invoke<void>("sftp_mkdir", { id, path });

export const sftpCreateFile = (id: string, path: string) =>
  invoke<void>("sftp_create_file", { id, path });

export const sftpRemove = (id: string, path: string, isDir: boolean) =>
  invoke<void>("sftp_remove", { id, path, isDir });

export const sftpRename = (id: string, from: string, to: string) =>
  invoke<void>("sftp_rename", { id, from, to });

/**
 * `transfer`, on the four transfers below, is an id from `newTransferId`
 * that `cancelTransfer` can name while the copy runs. Otherwise the task
 * gets an id automatically and remains controllable in the transfer center.
 */
export const sftpDownload = (
  id: string,
  remote: string,
  local: string,
  onProgress: (progress: TransferProgress) => void,
  transfer?: string,
) => transferFiles(id, [{ local, remote, upload: false, directory: false }], onProgress, transfer);

export const sftpDownloadDirectory = (
  id: string,
  remote: string,
  local: string,
  onProgress: (progress: TransferProgress) => void,
  transfer?: string,
) => transferFiles(id, [{ local, remote, upload: false, directory: true }], onProgress, transfer);

export const sftpUpload = (
  id: string,
  local: string,
  remote: string,
  onProgress: (progress: TransferProgress) => void,
  transfer?: string,
) => transferFiles(id, [{ local, remote, upload: true, directory: false }], onProgress, transfer);

export const sftpUploadDirectory = (
  id: string,
  local: string,
  remote: string,
  onProgress: (progress: TransferProgress) => void,
  transfer?: string,
) => transferFiles(id, [{ local, remote, upload: true, directory: true }], onProgress, transfer);

let transferSerial = 0;

/** A fresh id for a cancellable transfer; see `sftpDownload`. */
export const newTransferId = (): string =>
  `transfer-${Date.now().toString(36)}-${++transferSerial}`;

/**
 * Stops the transfer registered as `transfer`, if it is still running: the
 * copy ends within a chunk, its half-written file is removed, and the
 * transfer's promise rejects. Only for a transfer whose promise is still
 * pending; a cancel after it settled would linger in the backend's list.
 */
export const cancelTransfer = (transfer: string) =>
  invoke<void>("cancel_transfer", { transfer });

// --- local filesystem -------------------------------------------------------

export const localHome = () => invoke<string>("local_home");

/**
 * Where a shell or SSH session's foreground job is right now: the OS is
 * asked for a local shell, the server for an SSH one (see `session/cwd.rs`).
 */
export const sessionCwd = (id: string) =>
  invoke<string>("session_cwd", { id });

export const localHostname = () => invoke<string>("local_hostname");

/**
 * Path of the Windows drive list the local browser reaches by going up from a
 * drive root. Mirrors `fs_local::THIS_PC`; nothing can be created or deleted
 * there.
 */
export const LOCAL_DRIVES_ROOT = "This PC";

export const localList = (path: string) =>
  invoke<DirListing>("local_list", { path });

export const localParent = (path: string) =>
  invoke<string>("local_parent", { path });

export const localMkdir = (path: string) =>
  invoke<void>("local_mkdir", { path });

export const localCreateFile = (path: string) =>
  invoke<void>("local_create_file", { path });

export const localRename = (from: string, to: string) =>
  invoke<void>("local_rename", { from, to });

export const localRemove = (path: string, isDir: boolean) =>
  invoke<void>("local_remove", { path, isDir });

/** What a copy into the Filer's local folder did; see `localCopyInto`. */
export type LocalCopySummary = Wire.LocalCopySummary;

/**
 * Copies a file or folder into `destination` under its own name, for a drop
 * on a Filer that is showing local files. Folders are merged and files are
 * replaced, as a download into a local folder does; an item dropped on the
 * folder it already lives in is skipped rather than truncated.
 */
export const localCopyInto = (
  source: string,
  destination: string,
  onProgress: (progress: TransferProgress) => void,
) => {
  const progress = new Channel<TransferProgress>();
  progress.onmessage = onProgress;
  return invoke<LocalCopySummary>("local_copy_into", {
    source,
    destination,
    onProgress: progress,
  });
};

/** Opens a local file with the default application, or with `app` if given. */
export const openLocalPath = (path: string, app?: string) =>
  invoke<void>("open_local_path", { path, with: app ?? null });

/** Windows only: the system "Open with" chooser for a local file. */
export const openWithDialog = (path: string) =>
  invoke<void>("open_with_dialog", { path });

// --- dragging files out of the window ---------------------------------------

/**
 * Where a remote entry is downloaded to before it is handed to the system
 * drag on Windows and Linux (macOS promises the file instead; see
 * `startPromisedFileDrag`). Each call returns a fresh path; the staging
 * folder is cleared on the next launch, not when the drag ends, because the
 * drop target does the copy itself and may still be reading.
 */
export const dragStagingPath = (name: string) =>
  invoke<string>("drag_staging_path", { name });

/** How a drag out of the window ended; see `startFileDrag`. */
export type FileDragOutcome = Wire.FileDragOutcome;

/**
 * Hands `paths` to the system as a drag, so the Filer can drop a file on the
 * desktop or in a file manager. The pointer has to still be down: the drag
 * attaches to the gesture the user is already making.
 *
 * The promise resolves as soon as the drag is queued; `onFinished` is what
 * reports the outcome, once for every drag, and it is also where a drag that
 * never started shows up.
 */
export const startFileDrag = (
  paths: string[],
  onFinished: (outcome: FileDragOutcome) => void,
) => {
  const events = new Channel<FileDragOutcome>();
  events.onmessage = onFinished;
  return invoke<void>("start_file_drag", { paths, onEvent: events });
};

/**
 * What a promised drag reports; see `startPromisedFileDrag`. `write` comes
 * when a drop target takes the promise, once per drop in practice, and may
 * arrive after `ended`. `failed` replaces both when the drag never started.
 */
export type PromisedDragEvent =
  | {
      kind: "write";
      /** Goes back through `finishPromisedFile` once the file is settled. */
      token: string;
      /** The full local path the target wants, name included. */
      destination: string;
    }
  | { kind: "ended"; dropped: boolean }
  | { kind: "failed"; error: string };

/**
 * macOS only: drags a *promise* of the entry called `name` out of the window
 * instead of a copy. Nothing is downloaded while the drag is in flight; a
 * target that takes the drop names the path it wants, and that is when the
 * Filer downloads straight there. As with `startFileDrag`, the pointer has
 * to still be down.
 */
export const startPromisedFileDrag = (
  name: string,
  isDir: boolean,
  onEvent: (event: PromisedDragEvent) => void,
) => {
  const events = new Channel<PromisedDragEvent>();
  events.onmessage = onEvent;
  return invoke<void>("start_promised_file_drag", {
    name,
    isDir,
    onEvent: events,
  });
};

/**
 * Settles a promised drag's `write`: the target waiting on `token` gets its
 * file, or `error` as the reason it is not coming.
 */
export const finishPromisedFile = (token: string, error: string | null) =>
  invoke<void>("finish_promised_file", { token, error });

// --- remote files edited locally -------------------------------------------

/**
 * Where a remote file opened in a local application is downloaded to. While
 * the file is being watched this is the same path again, so reopening it
 * refreshes the copy the editor already has.
 */
export const remoteEditPath = (id: string, remote: string, name: string) =>
  invoke<string>("remote_edit_path", { id, remote, name });

/**
 * From now on, every change to `local` is uploaded back to `remote`. Call it
 * right after the download so the fresh copy is the baseline.
 */
export const watchRemoteEdit = (id: string, local: string, remote: string) =>
  invoke<void>("watch_remote_edit", { id, local, remote });

/** Stops watching every file opened from a session; for a tab closed for good. */
export const stopRemoteEdits = (id: string) =>
  invoke<void>("stop_remote_edits", { id });

export interface RemoteEditEvent {
  sessionId: string;
  remotePath: string;
  name: string;
  /** `kept`: the watch ended with unsent changes; the copy stays on disk. */
  status: "uploading" | "synced" | "error" | "kept";
  message: string | null;
}

export const onRemoteEditState = (
  handler: (event: RemoteEditEvent) => void,
): Promise<UnlistenFn> =>
  listen<RemoteEditEvent>("remote-edit:state", (e) => handler(e.payload));

// --- serial -----------------------------------------------------------------

export const listSerialPorts = () =>
  invoke<SerialPortDesc[]>("list_serial_ports");

// --- events -----------------------------------------------------------------

export const onSessionState = (
  handler: (event: StateEvent) => void,
): Promise<UnlistenFn> =>
  events.sessionState.listen((e) => handler(e.payload));

/** A session recording that can no longer be written; see session/recording.rs. */
export type RecordingError = Wire.RecordingErrorEvent;

export const onRecordingError = (
  handler: (event: RecordingError) => void,
): Promise<UnlistenFn> =>
  events.sessionRecordingError.listen((e) => handler(e.payload));

/** A server asking for a verification code (or another factor) mid-connect. */
export const onAuthPrompt = (
  handler: (prompt: AuthPrompt) => void,
): Promise<UnlistenFn> =>
  events.sessionAuthPrompt.listen((e) => handler(e.payload));

/**
 * Fired by the Rust menu handler when the user hits ⌘Q / Quit on macOS;
 * the frontend owns the confirm-and-exit flow (see App.tsx).
 */
export const onQuitRequested = (handler: () => void): Promise<UnlistenFn> =>
  listen("app:quit-requested", () => handler());

// --- window chrome (Windows) ------------------------------------------------

export type WindowControlAction = "minimize" | "toggle-maximize";

/**
 * Minimize / maximize / restore the main window. On Windows this takes the
 * same `WM_SYSCOMMAND` route as native caption buttons, which keeps the DWM
 * grow / shrink animation (`window.toggleMaximize()` does not); elsewhere it
 * forwards to the window (see `window_control` in lib.rs).
 */
export const windowControl = (action: WindowControlAction): Promise<void> =>
  invoke("window_control", { action });

// --- start-up appearance ----------------------------------------------------

/**
 * Remembers the theme for the next launch. A window is created — and painted —
 * before anything can read the settings this webview keeps, so the backend
 * holds on to this one alone (see `create_main_window` in lib.rs).
 */
export const setStartupTheme = (theme: ThemeMode): Promise<void> =>
  invoke("set_startup_theme", { theme });

/**
 * Reveals the main window. It starts hidden so that what appears is the
 * painted interface and not an empty frame, so this belongs after the first
 * paint and nowhere else; the backend shows the window itself if it never
 * arrives.
 */
export const showMainWindow = (): Promise<void> => invoke("show_main_window");
export const finishMainWindow = (): Promise<void> => invoke("finish_main_window");

/**
 * The clipboard's text as the process reads it. The paste path on macOS,
 * where a page read outside WebKit's own ⌘V pops a confirmation menu, and
 * the fallback on Windows for a WebView2 profile that refuses the page's
 * read (see `read_clipboard_text`).
 */
export const readClipboardText = (): Promise<string> =>
  invoke("read_clipboard_text");

/**
 * Puts text on the clipboard from the process: what a program's OSC 52 write
 * uses on macOS and Windows, where it arrives outside any user gesture (see
 * `write_clipboard_text`).
 */
export const writeClipboardText = (text: string): Promise<void> =>
  invoke("write_clipboard_text", { text });

/**
 * Brings the mouse pointer back before a native dialog opens. macOS hides it
 * while the user types and only restores it once this process sees the mouse
 * move, which never happens while a file panel is up — so `rz`, whose panel
 * opens on the command just typed, would be picked blind. See `show_pointer`
 * in commands.rs; every native dialog goes through `nativeDialog.ts`.
 */
export const showPointer = (): Promise<void> => invoke("show_pointer");

// --- portable mode ----------------------------------------------------------

/**
 * Whether this copy runs in portable mode: a `data` directory next to the
 * executable holds all configuration (the Windows portable zip ships one).
 * Portable copies must not install updates in place; the updater opens the
 * release download page instead.
 */
export const portableMode = (): Promise<boolean> => invoke("portable_mode");

export interface PortForwardSpec {
  direction: "local" | "remote";
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
}
export interface PortForward {
  id: string;
  owner: string;
  address: string;
  spec: PortForwardSpec;
  status: "starting" | "listening" | "stopping" | "stopped" | "error";
  error: string | null;
  connections: number;
  sentBytes: number;
  receivedBytes: number;
}
export interface PortDiscovery { status: "ok" | "unsupported"; ports: { host: string; port: number; process: string | null }[]; truncated: boolean }
export const startPortForward = (id: string, spec: PortForwardSpec): Promise<PortForward> => invoke("start_port_forward", { id, spec });
export const listPortForwards = (): Promise<PortForward[]> => invoke("list_port_forwards");
export const stopPortForward = (id: string): Promise<void> => invoke("stop_port_forward", { id });
export const removePortForward = (id: string): Promise<void> => invoke("remove_port_forward", { id });
export const discoverListeningPorts = (id: string, requestId: string): Promise<PortDiscovery> => invoke("discover_listening_ports", { id, requestId });
export const cancelPortDiscovery = (requestId: string): Promise<void> => invoke("cancel_port_discovery", { requestId });

// --- encoding helpers -------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
