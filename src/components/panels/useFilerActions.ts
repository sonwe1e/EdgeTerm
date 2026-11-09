import type { useFileSelection } from "../../useFileSelection";
import { openFileEditor } from "../../fileEditor";
import { isPreviewRunning, previewReport, stopReportPreview } from "../../previewActions";
import { useStore } from "../../store";
import { isConnectionClosing } from "../../sessionConnectionLifecycle";
import { errorText } from "../../errorInfo";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { type MouseEvent, useRef } from "react";
import * as api from "../../api";
import type { Translate } from "../../i18n";
import { open as openDialog } from "../../nativeDialog";
import { IS_MAC, IS_WINDOWS } from "../../platform";
import type { FileEntry } from "../../types";
import { imagePreviewMime } from "../../imagePreview";
import { type MenuItem } from "../ContextMenu";
import { appDisplayName, joinLocal, joinRemote, rememberOpenWithApp } from "./filerPresentation";
import type { MenuState, NewEntryDraft, RenameDraft, TransferState } from "./filerTypes";

interface Options {
  setPendingDelete: Dispatch<SetStateAction<readonly FileEntry[] | null>>;
  remoteId: string | null;
  path: string;
  busyRef: RefObject<boolean>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  remoteIdRef: RefObject<string | null>;
  pathRef: RefObject<string>;
  load: (target: string, quiet?: boolean, resume?: boolean) => Promise<boolean>;
  selection: ReturnType<typeof useFileSelection>;
  beginTransfer: (
    kind: TransferState["kind"],
    name: string,
    cancellable?: boolean,
  ) => string | undefined;
  progressFor: (id: string | undefined) => (progress: api.TransferProgress) => void;
  finishTransfer: (status: "complete" | "error" | "cancelled", id?: string | undefined) => void;
  failTransfer: (e: unknown, id?: string | undefined) => void;
  ownsTransfer: (id: string | undefined) => boolean;
  setOpenWithApps: Dispatch<SetStateAction<string[]>>;
  busy: boolean;
  t: Translate;
  setMenu: Dispatch<SetStateAction<MenuState | null>>;
  openWithApps: string[];
  remote: boolean;
  choosingDownload: boolean;
  downloadEntries: (entries: readonly FileEntry[]) => Promise<void>;
  atDrivesRoot: boolean;
  setCreating: Dispatch<SetStateAction<NewEntryDraft | null>>;
  /** Opens the inline rename editor on `entry`; owned by the panel. */
  startRename: (entry: FileEntry) => void;
  /** The rename in progress, with its draft text; null when none is. */
  renaming: RenameDraft | null;
  setRenaming: Dispatch<SetStateAction<RenameDraft | null>>;
  upload: () => Promise<void>;
  uploadFolder: () => Promise<void>;
  creating: NewEntryDraft | null;
  entries: FileEntry[];
  previewImage: (entry: FileEntry) => void;
  /** Opens a bounded read-only viewer; never creates an editable temp copy. */
  onViewLog: (entry: FileEntry) => void;
}

export function useFilerActions({
  setPendingDelete,
  remoteId,
  path,
  busyRef,
  setBusy,
  setError,
  remoteIdRef,
  pathRef,
  load,
  selection,
  beginTransfer,
  progressFor,
  finishTransfer,
  failTransfer,
  ownsTransfer,
  setOpenWithApps,
  busy,
  t,
  setMenu,
  openWithApps,
  remote,
  choosingDownload,
  downloadEntries,
  atDrivesRoot,
  setCreating,
  startRename,
  renaming,
  setRenaming,
  upload,
  uploadFolder,
  creating,
  entries,
  previewImage,
  onViewLog,
}: Options) {
  const actionContext = useRef({ remoteId, path });
  if (actionContext.current.remoteId !== remoteId || actionContext.current.path !== path) {
    actionContext.current = { remoteId, path };
  }
  const removeEntries = async (chosen: readonly FileEntry[]) => {
    setPendingDelete(null);
    const sessionId = remoteId;
    const destination = path;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const failed: { entry: FileEntry; error: unknown }[] = [];
    try {
      for (const entry of chosen) {
        try {
          // The confirmation ahead of this call says a folder goes with its
          // contents; a link is still only the link, so it is never walked.
          const recursive = entry.isDir && !entry.isSymlink;
          if (sessionId) await api.sftpRemove(sessionId, entry.path, entry.isDir, recursive);
          else await api.localRemove(entry.path, entry.isDir, recursive);
        } catch (error) {
          failed.push({ entry, error });
        }
      }
      if (remoteIdRef.current === sessionId && pathRef.current === destination)
        await load(destination);
      if (remoteIdRef.current === sessionId && pathRef.current === destination && failed.length) {
        selection.replace(failed.map(({ entry }) => entry.path));
        setError(failed.map(({ entry, error }) => `${entry.name}: ${errorText(error)}`).join("\n"));
      }
    } finally {
      if (remoteIdRef.current === sessionId && pathRef.current === destination) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch((e) => setError(errorText(e)));
  };

  // A transfer may finish in the background after the Filer switches to B.
  // Its owner is still A, but closing A retires the later watch/app-open steps.
  const remoteEditSourceAvailable = () =>
    remoteId === null ||
    (!isConnectionClosing(remoteId) &&
      useStore.getState().tabs.some((tab) => tab.info.id === remoteId));

  /**
   * The local path to hand to an application: the entry itself for local
   * sessions, otherwise a copy downloaded into the temp folder that the
   * backend then watches, sending every save back to the server. Null when
   * the download failed (the error is already shown).
   */
  const localCopyOf = async (entry: FileEntry): Promise<string | null> => {
    if (!remoteId) return entry.path;
    if (busyRef.current || !remoteEditSourceAvailable()) return null;
    const context = actionContext.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("download", entry.name, true);
    const stillAvailable = () => {
      if (remoteEditSourceAvailable()) return true;
      finishTransfer("cancelled", transfer);
      return false;
    };
    try {
      const target = await api.remoteEditPath(remoteId, entry.path, entry.name);
      if (!stillAvailable()) return null;
      // Reopening an external editor must preserve the existing local draft,
      // including saves waiting for a failed/offline upload to be retried.
      if (!target.reused) {
        await api.sftpDownload(remoteId, entry.path, target.path, progressFor(transfer), transfer);
        if (!stillAvailable()) return null;
        await api.watchRemoteEdit(remoteId, target.path, entry.path);
        if (!stillAvailable()) return null;
      }
      finishTransfer("complete", transfer);
      return target.path;
    } catch (e) {
      if (stillAvailable()) {
        if (actionContext.current === context) failTransfer(e, transfer);
        else finishTransfer("error", transfer);
      }
      return null;
    } finally {
      if (ownsTransfer(transfer) && actionContext.current === context) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  /** Opens a file with the default application, or with `app` when given. */
  const openEntry = async (entry: FileEntry, app?: string) => {
    const target = await localCopyOf(entry);
    if (!target || !remoteEditSourceAvailable()) return;
    try {
      await api.openLocalPath(target, app);
      if (!remoteEditSourceAvailable()) return;
      if (app) setOpenWithApps(rememberOpenWithApp(app));
    } catch (e) {
      if (remoteEditSourceAvailable() && remoteIdRef.current === remoteId) setError(errorText(e));
    }
  };

  /** Double-click and Enter share the context menu's default, read-only image action. */
  const activate = (entry: FileEntry) => {
    if (entry.isDir) void load(entry.path);
    else if (!busy) {
      if (imagePreviewMime(entry.name)) previewImage(entry);
      else void openEntry(entry);
    }
  };

  /**
   * Lets the user pick the application first. Windows has a system chooser
   * that also knows the registered handlers; elsewhere the application is a
   * file to pick (a macOS `.app` bundle, a program on Linux).
   */
  const openEntryWith = async (entry: FileEntry) => {
    if (IS_WINDOWS) {
      const target = await localCopyOf(entry);
      if (!target || !remoteEditSourceAvailable()) return;
      await api.openWithDialog(target).catch((e) => {
        if (remoteEditSourceAvailable() && remoteIdRef.current === remoteId) setError(errorText(e));
      });
      return;
    }
    const picked = await openDialog({
      title: t("filer.openWithTitle", { name: entry.name }),
      multiple: false,
      directory: false,
      ...(IS_MAC
        ? {
            defaultPath: "/Applications",
            filters: [{ name: "Applications", extensions: ["app"] }],
          }
        : { defaultPath: "/usr/bin" }),
    });
    if (typeof picked === "string" && remoteEditSourceAvailable()) await openEntry(entry, picked);
  };

  /**
   * A remote HTML report opens in the system browser through the session's own
   * SSH connection: the preview server reads the report's directory, so unlike
   * a downloaded file the scripts and data beside it still load, and a refresh
   * picks up what a training run has written since.
   */
  const canPreviewReport = (entry: FileEntry): boolean =>
    remoteId !== null &&
    !entry.isDir &&
    /\.html?$/i.test(entry.name) &&
    useStore.getState().tabs.find((tab) => tab.info.id === remoteId)?.info.kind === "ssh";

  const previewMenuItem = (entry: FileEntry): MenuItem => {
    const id = remoteId as string;
    return isPreviewRunning(id, entry.path)
      ? {
          label: t("filer.previewStop"),
          icon: "close",
          action: () => void stopReportPreview(id, entry.path),
        }
      : {
          label: t("filer.previewInBrowser"),
          icon: "link-external",
          disabled: busy,
          action: () => void previewReport(id, entry.path),
        };
  };

  const openMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openWithMenu = (entry: FileEntry): MenuItem => {
    const other = {
      label: openWithApps.length > 0 ? t("filer.other") : t("filer.openWithEllipsis"),
      disabled: busy,
      action: () => void openEntryWith(entry),
    };
    if (openWithApps.length === 0) return { ...other, icon: "link-external" };
    return {
      label: t("filer.openWithMenu"),
      icon: "link-external",
      children: [
        ...openWithApps.map((app) => ({
          label: appDisplayName(app),
          disabled: busy,
          action: () => void openEntry(entry, app),
        })),
        "separator",
        other,
      ],
    };
  };

  const entryMenu = (entry: FileEntry, chosen: readonly FileEntry[]): MenuItem[] => [
    ...(chosen.length > 1
      ? []
      : [
          entry.isDir
            ? {
                label: t("filer.open"),
                icon: "folder-opened" as const,
                action: () => void load(entry.path),
              }
            : imagePreviewMime(entry.name)
              ? {
                  label: t("filer.previewImage"),
                  icon: "file-media" as const,
                  disabled: busy,
                  action: () => previewImage(entry),
                }
              : {
                  label: t("filer.open"),
                  icon: "go-to-file" as const,
                  disabled: busy,
                  action: () => void openEntry(entry),
                },
          ...(entry.isDir
            ? []
            : [
                ...(imagePreviewMime(entry.name)
                  ? [
                      {
                        label: t("filer.openExternallyEditable"),
                        icon: "link-external" as const,
                        disabled: busy,
                        action: () => void openEntry(entry),
                      },
                    ]
                  : []),
                {
                  label: t("fileEditor.title"),
                  icon: "edit" as const,
                  disabled: busy,
                  action: () => void openFileEditor(remoteId, entry.path),
                },
                {
                  label: t("logViewer.menu"),
                  icon: "find-in-files" as const,
                  disabled: busy,
                  action: () => onViewLog(entry),
                },
                ...(canPreviewReport(entry) ? [previewMenuItem(entry)] : []),
                openWithMenu(entry),
              ]),
          {
            label: t("filer.rename"),
            icon: "edit" as const,
            disabled: busy || atDrivesRoot,
            action: () => startRename(entry),
          },
        ]),
    ...(remote
      ? [
          {
            label: t("filer.downloadEllipsis"),
            icon: "cloud-download" as const,
            disabled: busy || choosingDownload,
            action: () => void downloadEntries(chosen),
          },
        ]
      : []),
    "separator",
    {
      label: t("filer.copyPath"),
      icon: "copy",
      action: () => copyText(chosen.map((item) => item.path).join("\n")),
    },
    {
      label: t("filer.copyName"),
      icon: "tag",
      action: () => copyText(chosen.map((item) => item.name).join("\n")),
    },
    "separator",
    {
      label: t("panel.deleteEllipsis"),
      icon: "trash",
      danger: true,
      disabled: busy || atDrivesRoot,
      action: () => setPendingDelete(chosen),
    },
  ];

  /** Menu for the empty part of the list: actions on the current folder. */
  const folderMenu = (): MenuItem[] => [
    {
      label: t("filer.newFile"),
      icon: "new-file",
      disabled: busy || !path || atDrivesRoot,
      action: () => setCreating({ kind: "file", name: "" }),
    },
    {
      label: t("filer.newFolder"),
      icon: "new-folder",
      disabled: busy || !path || atDrivesRoot,
      action: () => setCreating({ kind: "folder", name: "" }),
    },
    ...(remote
      ? [
          "separator" as const,
          {
            label: t("filer.uploadFiles"),
            icon: "cloud-upload" as const,
            disabled: busy || !path,
            action: () => void upload(),
          },
          {
            label: t("filer.uploadFolder"),
            icon: "cloud-upload" as const,
            disabled: busy || !path,
            action: () => void uploadFolder(),
          },
        ]
      : []),
    "separator",
    {
      label: t("filer.copyFolderPath"),
      icon: "copy",
      disabled: !path || atDrivesRoot,
      action: () => copyText(path),
    },
    {
      label: t("filer.refresh"),
      icon: "refresh",
      disabled: busy,
      action: () => void load(path),
    },
  ];

  const commitNewEntry = async () => {
    const draft = creating;
    const name = draft?.name.trim();
    if (!draft || !name || !path || atDrivesRoot) return;
    const kindWord = draft.kind === "folder" ? t("filer.folder") : t("filer.file");
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      setError(t("filer.invalidName", { name, kind: kindWord }));
      return;
    }
    if (entries.some((entry) => entry.name === name)) {
      setError(t("filer.alreadyExists", { name }));
      return;
    }
    // Only a valid, accepted name closes the inline editor: a rejected one
    // keeps the text so the user can correct it instead of retyping it.
    setCreating(null);
    try {
      if (remoteId) {
        const target = joinRemote(path, name);
        if (draft.kind === "folder") await api.sftpMkdir(remoteId, target);
        else await api.sftpCreateFile(remoteId, target);
      } else {
        const target = joinLocal(path, name);
        if (draft.kind === "folder") await api.localMkdir(target);
        else await api.localCreateFile(target);
      }
      await load(path);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /**
   * Renames the one entry the inline editor holds. The checks are the ones
   * `commitNewEntry` makes — a name that is empty, a path, or already taken
   * keeps the editor open with its text — and the rename itself is the same
   * backend call the dual-pane browsers use.
   */
  const commitRename = async () => {
    const draft = renaming;
    const name = draft?.name.trim();
    if (!draft || !name || !path || atDrivesRoot) return;
    const from = draft.entry.path;
    if (name === draft.entry.name) {
      setRenaming(null);
      return;
    }
    const kindWord = draft.entry.isDir ? t("filer.folder") : t("filer.file");
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      setError(t("filer.invalidName", { name, kind: kindWord }));
      return;
    }
    if (entries.some((entry) => entry.name === name)) {
      setError(t("filer.alreadyExists", { name }));
      return;
    }
    setRenaming(null);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const context = actionContext.current;
    const current = () => actionContext.current === context;
    try {
      const to = remoteId ? joinRemote(path, name) : joinLocal(path, name);
      if (remoteId) await api.sftpRename(remoteId, from, to);
      else await api.localRename(from, to);
      if (current()) await load(path);
    } catch (e) {
      if (current()) setError(errorText(e));
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return { activate, openMenu, entryMenu, folderMenu, commitNewEntry, commitRename, removeEntries };
}
