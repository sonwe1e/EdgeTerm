import type { useFileSelection } from "../../useFileSelection";
import { errorText } from "../../errorInfo";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { type MouseEvent } from "react";
import * as api from "../../api";
import type { Translate } from "../../i18n";
import { open as openDialog } from "../../nativeDialog";
import { IS_MAC, IS_WINDOWS } from "../../platform";
import type { FileEntry } from "../../types";
import { type MenuItem } from "../ContextMenu";
import { appDisplayName, joinLocal, joinRemote, rememberOpenWithApp } from "./filerPresentation";
import type { MenuState, NewEntryDraft, TransferState } from "./filerTypes";

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
  upload: () => Promise<void>;
  uploadFolder: () => Promise<void>;
  creating: NewEntryDraft | null;
  entries: FileEntry[];
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
  upload,
  uploadFolder,
  creating,
  entries,
}: Options) {
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
          if (sessionId) await api.sftpRemove(sessionId, entry.path, entry.isDir);
          else await api.localRemove(entry.path, entry.isDir);
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

  /**
   * The local path to hand to an application: the entry itself for local
   * sessions, otherwise a copy downloaded into the temp folder that the
   * backend then watches, sending every save back to the server. Null when
   * the download failed (the error is already shown).
   */
  const localCopyOf = async (entry: FileEntry): Promise<string | null> => {
    if (!remoteId) return entry.path;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("download", entry.name, true);
    try {
      const target = await api.remoteEditPath(remoteId, entry.path, entry.name);
      await api.sftpDownload(remoteId, entry.path, target, progressFor(transfer), transfer);
      await api.watchRemoteEdit(remoteId, target, entry.path);
      finishTransfer("complete", transfer);
      return target;
    } catch (e) {
      failTransfer(e, transfer);
      return null;
    } finally {
      if (ownsTransfer(transfer)) setBusy(false);
    }
  };

  /** Opens a file with the default application, or with `app` when given. */
  const openEntry = async (entry: FileEntry, app?: string) => {
    const target = await localCopyOf(entry);
    if (!target) return;
    try {
      await api.openLocalPath(target, app);
      if (app) setOpenWithApps(rememberOpenWithApp(app));
    } catch (e) {
      setError(errorText(e));
    }
  };

  /**
   * A double-click does what the entry's own Open action does: enter a folder,
   * or hand a file to its application (a remote one as a watched local copy).
   */
  const activate = (entry: FileEntry) => {
    if (entry.isDir) void load(entry.path);
    else if (!busy) void openEntry(entry);
  };

  /**
   * Lets the user pick the application first. Windows has a system chooser
   * that also knows the registered handlers; elsewhere the application is a
   * file to pick (a macOS `.app` bundle, a program on Linux).
   */
  const openEntryWith = async (entry: FileEntry) => {
    if (IS_WINDOWS) {
      const target = await localCopyOf(entry);
      if (!target) return;
      await api.openWithDialog(target).catch((e) => setError(errorText(e)));
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
    if (typeof picked === "string") await openEntry(entry, picked);
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
            : {
                label: t("filer.open"),
                icon: "go-to-file" as const,
                disabled: busy,
                action: () => void openEntry(entry),
              },
          ...(entry.isDir ? [] : [openWithMenu(entry)]),
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

  return { activate, openMenu, entryMenu, folderMenu, commitNewEntry, removeEntries };
}
