import { useStore } from "./store";
import { workspacePath, type WorkspaceDirectories } from "./workspaceSnapshot";

// The docked local Filer is a shared source; FTP/SFTP local panes are per tab.
export const getLocalFilerPath = () => useStore.getState().localFilerPath;
export function rememberLocalFilerPath(path: string): void {
  if (workspacePath(path) === undefined || path === getLocalFilerPath()) return;
  useStore.setState({ localFilerPath: path });
}

export function rememberWorkspaceDirectory(
  id: string,
  kind: keyof WorkspaceDirectories,
  path: string,
): void {
  if (workspacePath(path) === undefined || (kind === "terminal" && !path)) return;
  const state = useStore.getState();
  const tab = state.tabs.find((tab) => tab.info.id === id);
  if (!tab || tab.directories?.[kind] === path) return;
  useStore.setState({
    tabs: state.tabs.map((item) =>
      item === tab ? { ...item, directories: { ...item.directories, [kind]: path } } : item,
    ),
  });
}
