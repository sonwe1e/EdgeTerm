import * as api from "./api";
import { errorText } from "./errorInfo";
import { t } from "./i18n";
import { ask, open as openDialog, save as saveDialog } from "./nativeDialog";
import { useStore } from "./store";
import { IMPORT_PROTECTED_SETTINGS } from "./storePreferenceActions";
import type { AppData } from "./types";

// Session → Export Data… / Import Data…: one `.edgeterm` file (plain JSON
// inside) holding the settings, saved sessions with their groups and Sender
// tags. Passwords and passphrases never leave `credentials.json`; the backend
// strips them on both sides, and the confirmation below says so, since
// imported sessions will ask again.

/** Mirrors `APP_DATA_EXTENSION` in model.rs; the backend enforces it too. */
export const DATA_FILE_EXTENSION = "edgeterm";
const fileFilters = () => [{ name: t("data.fileFilter"), extensions: [DATA_FILE_EXTENSION] }];

const hasDataExtension = (path: string) => path.toLowerCase().endsWith(`.${DATA_FILE_EXTENSION}`);

/**
 * Not every platform's save dialog appends the filter's extension to a typed
 * name; the export must carry it or the import side will refuse the file.
 */
const withDataExtension = (path: string) =>
  hasDataExtension(path) ? path : `${path}.${DATA_FILE_EXTENSION}`;

const describe = (counts: { profiles: number; groups: number; senderCommands: number }) =>
  [
    t(counts.profiles === 1 ? "data.sessionOne" : "data.sessionMany", {
      count: counts.profiles,
    }),
    t(counts.groups === 1 ? "data.groupOne" : "data.groupMany", {
      count: counts.groups,
    }),
    t(counts.senderCommands === 1 ? "data.commandOne" : "data.commandMany", {
      count: counts.senderCommands,
    }),
  ].join(", ");

const basename = (path: string) => path.split(/[\\/]/).pop() || path;

const datestamp = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

export async function exportAppData(): Promise<void> {
  const { exportSettings, setStatus } = useStore.getState();
  try {
    const now = new Date();
    const picked = await saveDialog({
      title: t("data.exportTitle"),
      defaultPath: `EdgeTerm-${datestamp(now)}.${DATA_FILE_EXTENSION}`,
      filters: fileFilters(),
    });
    if (!picked) return;
    const path = withDataExtension(picked);
    const summary = await api.exportAppData(path, exportSettings(), now.toISOString());
    setStatus(
      t("data.exportDone", {
        summary: describe(summary),
        file: basename(path),
      }),
    );
  } catch (error) {
    setStatus(t("data.exportFailed", { error: errorText(error) }));
  }
}

export async function importAppData(): Promise<void> {
  const store = useStore.getState();
  try {
    const picked = await openDialog({
      title: t("data.importTitle"),
      multiple: false,
      directory: false,
      filters: fileFilters(),
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    // The dialog filter already narrows the list, but "All files" and typed
    // paths get through on some platforms; say what was expected up front.
    if (!hasDataExtension(path)) {
      store.setStatus(
        t("data.notDataFile", {
          file: basename(path),
          ext: DATA_FILE_EXTENSION,
        }),
      );
      return;
    }

    // Parse first so the confirmation can say exactly what is coming in.
    const data: AppData = await api.readAppData(path);
    const hasSettings = !!data.settings && typeof data.settings === "object";
    const summary = describe({
      profiles: data.profiles.length,
      groups: data.groups.length,
      senderCommands: data.senderCommands.length,
    });
    // Which of the file's sessions already exist here decides whether the
    // import adds or overwrites; the dialog can only say so if it looks first.
    const known = new Set(useStore.getState().profiles.map((saved) => saved.id));
    const replacing = data.profiles.filter((saved) => known.has(saved.id)).length;
    const details = [
      t("data.importDetail"),
      replacing > 0 ? t("data.importReplaceWarning", { count: replacing }) : "",
      data.exportedAt ? t("data.importExportedAt", { when: data.exportedAt }) : "",
    ].filter(Boolean);
    const confirmed = await ask(
      `${t("data.importConfirm", {
        summary,
        andSettings: hasSettings ? t("data.importAndSettings") : "",
        file: basename(path),
      })}\n\n${details.join("\n\n")}`,
      {
        title: t("data.importOk"),
        kind: "info",
        okLabel: t("data.importOk"),
        cancelLabel: t("common.cancel"),
      },
    );
    if (!confirmed) return;

    const result = await api.importAppData(data);
    if (hasSettings) store.applySettings(data.settings);
    // The file's own wording cannot switch these off; say they were kept so the
    // imported settings are not mistaken for a full restore.
    const kept =
      hasSettings &&
      IMPORT_PROTECTED_SETTINGS.some((key) =>
        Object.prototype.hasOwnProperty.call(data.settings, key),
      );
    await store.loadProfiles();
    store.bumpSenderLibrary();
    let status = t("data.imported", {
      summary: describe(result),
      andSettings: hasSettings ? t("data.importAndSettings") : "",
    });
    if (kept) status += t("data.importSettingsKept");
    if (result.skippedSenderCommands === 1) {
      status += t("data.importSkippedOne");
    } else if (result.skippedSenderCommands > 1) {
      status += t("data.importSkippedMany", {
        count: result.skippedSenderCommands,
      });
    }
    store.setStatus(status);
  } catch (error) {
    store.setStatus(t("data.importFailed", { error: errorText(error) }));
  }
}

/**
 * Session → Import OpenSSH Config…: picks a client configuration (the file
 * dialog starts at ~/.ssh/config), parses it and opens the chooser; the
 * import itself happens in `SshConfigImportDialog`.
 */
export async function importSshConfig(): Promise<void> {
  const store = useStore.getState();
  try {
    const defaultPath = await api.defaultSshConfigPath();
    const picked = await openDialog({
      title: t("data.sshConfigTitle"),
      multiple: false,
      directory: false,
      defaultPath,
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    const preview = await api.readSshConfig(path);
    if (preview.entries.length === 0) {
      store.setStatus(t("data.noHostEntries", { file: basename(path) }));
      return;
    }
    store.setSshConfigImport(preview);
  } catch (error) {
    store.setStatus(t("data.importFailed", { error: errorText(error) }));
  }
}
