import * as api from "../api";
import { open as chooseFile } from "../nativeDialog";
import { useStore } from "../store";
import { t } from "../i18n";
import { getController } from "../terminalRegistry";

export function selectedAgentText(id: string, revision: number): string {
  const controller = getController(id);
  if (!controller || controller.connectionRevision !== revision)
    throw new Error(t("agent.selectionUnavailable"));
  const text = controller.getAgentSelection();
  if (!text) throw new Error(t("agent.selectionUnavailable"));
  return text;
}

/** Return a reference only once the upload and connection checks succeed. */
export async function chooseAgentReference(
  id: string,
  directory: string,
  current: () => boolean,
): Promise<string | null> {
  const tab = useStore.getState().tabs.find((row) => row.info.id === id);
  if (!tab || !current()) return null;
  const picked = await chooseFile({ multiple: false, directory: false });
  if (!picked || !current()) return null;
  if (tab.info.kind !== "ssh") return picked;
  if (!directory.startsWith("/")) throw new Error(t("agent.needDirectory"));
  const root = `${directory.replace(/\/$/, "")}/.edgeterm-attachments`;
  try {
    await api.sftpList(id, root);
  } catch {
    if (!current()) return null;
    await api.sftpMkdir(id, root);
  }
  if (!current()) return null;
  const name = picked
    .split(/[\\/]/)
    .pop()!
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${root}/${crypto.randomUUID()}-${name}`;
  await api.sftpUpload(id, picked, path, () => undefined);
  return current() ? path : null;
}
