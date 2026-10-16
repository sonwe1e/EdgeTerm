import { commands } from "./bindings";
import { errorText } from "./errorInfo";
import { t } from "./i18n";
import { save as saveDialog } from "./nativeDialog";
import { useStore } from "./store";

// Help menu → Open Log Directory / Export Diagnostics…: the two ways a user
// hands a problem to support. The backend owns the report's contents (build
// header plus a bounded log tail); this side only picks a destination and
// reports the outcome.

const FILE_FILTERS = [{ name: "Text", extensions: ["txt"] }];

const basename = (path: string) => path.split(/[\\/]/).pop() || path;

/** Not every platform's save dialog appends the filter's extension. */
const withTextExtension = (path: string) =>
  path.toLowerCase().endsWith(".txt") ? path : `${path}.txt`;

const datestamp = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

export async function openLogDirectory(): Promise<void> {
  const { setStatus } = useStore.getState();
  try {
    await commands.openLogDirectory();
  } catch (error) {
    setStatus(t("status.logDirectoryOpenFailed", { error: errorText(error) }));
  }
}

export async function exportDiagnostics(): Promise<void> {
  const { setStatus } = useStore.getState();
  try {
    const picked = await saveDialog({
      title: t("menu.exportDiagnostics"),
      defaultPath: `EdgeTerm-diagnostics-${datestamp(new Date())}.txt`,
      filters: FILE_FILTERS,
    });
    if (!picked) return;
    const path = withTextExtension(picked);
    await commands.exportDiagnostics(path);
    setStatus(t("status.diagnosticsExported", { file: basename(path) }));
  } catch (error) {
    setStatus(t("status.diagnosticsExportFailed", { error: errorText(error) }));
  }
}
