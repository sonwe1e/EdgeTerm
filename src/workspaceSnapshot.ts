import { leaf, paneIds, type LayoutNode } from "./layout";
import type { PaneState } from "./storeLayout";
import type { SessionProfile } from "./types";

// Session history is device-local, not a transferable preference. In particular,
// a settings import must never cause connections to another person's servers.
export const WORKSPACE_STORAGE_KEY = "edgeterm.workspace.v1";
export const WORKSPACE_LIMIT = 128;

export interface WorkspaceDirectories {
  terminal?: string;
  filer?: string;
  local?: string;
}

export interface SavedTab {
  id: string;
  profile: SessionProfile;
  number: number;
  ordinal: number;
  paneId: string;
  directories: WorkspaceDirectories;
}

export interface WorkspaceSnapshot {
  version: 1;
  tabs: SavedTab[];
  panes: PaneState["panes"];
  layout: LayoutNode;
  activePaneId: string;
  localFilerPath?: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function workspacePath(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined;
}

const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 256;

/** An allowlist: adding a secret to SessionProfile cannot silently persist it. */
export function workspaceProfile(value: unknown): SessionProfile | null {
  if (
    !object(value) ||
    !["local", "ssh", "sftp", "ftp", "telnet", "serial"].includes(String(value.kind))
  )
    return null;
  const result: Record<string, unknown> = { id: "", kind: value.kind, name: "session" };
  for (const key of [
    "id",
    "name",
    "color",
    "groupId",
    "encoding",
    "locale",
    "backspace",
    "recordDir",
    "shell",
    "cwd",
    "host",
    "username",
    "auth",
    "privateKeyPath",
    "jumpProfileId",
    "portName",
    "parity",
    "flowControl",
  ]) {
    if (typeof value[key] === "string" && value[key].length <= 8192) result[key] = value[key];
  }
  for (const key of ["port", "baudRate", "dataBits", "stopBits"]) {
    if (typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] > 0)
      result[key] = value[key];
  }
  if (typeof value.record === "boolean") result.record = value.record;
  // Saved profiles supply their current forwards and credentials at startup.
  // Ad-hoc profiles have no forwards in the session dialog.
  return result as unknown as SessionProfile;
}

function directories(value: unknown): WorkspaceDirectories {
  if (!object(value)) return {};
  return {
    terminal: workspacePath(value.terminal) || undefined,
    filer: workspacePath(value.filer),
    local: workspacePath(value.local),
  };
}

function layout(
  value: unknown,
  allowed: Set<string>,
  seen = new Set<string>(),
  depth = 0,
): LayoutNode | null {
  if (!object(value) || depth > 16) return null;
  if (
    value.kind === "leaf" &&
    id(value.paneId) &&
    allowed.has(value.paneId) &&
    !seen.has(value.paneId)
  ) {
    seen.add(value.paneId);
    return leaf(value.paneId);
  }
  if (
    value.kind !== "split" ||
    !["row", "column"].includes(String(value.direction)) ||
    !Array.isArray(value.children) ||
    value.children.length < 2 ||
    value.children.length > WORKSPACE_LIMIT ||
    !Array.isArray(value.sizes) ||
    value.sizes.length !== value.children.length
  )
    return null;
  const children = value.children.map((child) => layout(child, allowed, seen, depth + 1));
  const sizes = value.sizes;
  if (
    children.some((child) => !child) ||
    sizes.some((size) => typeof size !== "number" || !Number.isFinite(size) || size <= 0)
  )
    return null;
  const total = sizes.reduce((sum: number, size: number) => sum + size, 0);
  if (!Number.isFinite(total)) return null;
  return {
    kind: "split",
    direction: value.direction as "row" | "column",
    children: children as LayoutNode[],
    sizes: sizes.map((size: number) => size / total),
  };
}

export function parseWorkspace(raw: string | null): WorkspaceSnapshot | null {
  try {
    if (!raw || raw.length > 2_000_000) return null;
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || !Array.isArray(value.tabs)) return null;
    const tabs: SavedTab[] = [];
    const ids = new Set<string>();
    const numbers = new Set<number>();
    for (const item of value.tabs.slice(0, WORKSPACE_LIMIT)) {
      if (!object(item) || !id(item.id) || ids.has(item.id)) continue;
      const profile = workspaceProfile(item.profile);
      if (!profile) continue;
      ids.add(item.id);
      let number =
        Number.isSafeInteger(item.number) &&
        Number(item.number) > 0 &&
        Number(item.number) <= WORKSPACE_LIMIT
          ? Number(item.number)
          : 1;
      while (numbers.has(number)) number++;
      numbers.add(number);
      const siblings = tabs.filter(
        (tab) => (tab.profile.id || tab.profile.name) === (profile.id || profile.name),
      );
      let ordinal =
        Number.isSafeInteger(item.ordinal) &&
        Number(item.ordinal) >= 0 &&
        Number(item.ordinal) < WORKSPACE_LIMIT
          ? Number(item.ordinal)
          : 0;
      while (siblings.some((tab) => tab.ordinal === ordinal)) ordinal++;
      tabs.push({
        id: item.id,
        profile,
        number,
        ordinal,
        paneId: id(item.paneId) ? item.paneId : "root",
        directories: directories(item.directories),
      });
    }
    const paneSet = new Set(tabs.map((tab) => tab.paneId));
    if (!paneSet.size) paneSet.add("root");
    let tree = layout(value.layout, paneSet);
    if (!tree || paneIds(tree).length !== paneSet.size) {
      const root = tabs[0]?.paneId ?? "root";
      tree = leaf(root);
      for (const tab of tabs) tab.paneId = root;
    }
    const panes = paneIds(tree).map((paneId) => {
      const saved = Array.isArray(value.panes)
        ? value.panes.find((pane) => object(pane) && pane.id === paneId)
        : null;
      const children = tabs.filter((tab) => tab.paneId === paneId);
      return {
        id: paneId,
        activeTabId:
          children.find((tab) => tab.id === saved?.activeTabId)?.id ?? children[0]?.id ?? null,
      };
    });
    return {
      version: 1,
      tabs,
      panes,
      layout: tree,
      activePaneId: panes.find((pane) => pane.id === value.activePaneId)?.id ?? panes[0].id,
      localFilerPath: workspacePath(value.localFilerPath),
    };
  } catch {
    return null;
  }
}

export function loadWorkspaceSnapshot(): WorkspaceSnapshot | null {
  try {
    return parseWorkspace(localStorage.getItem(WORKSPACE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function snapshotWorkspace(state: PaneState, localFilerPath?: string): WorkspaceSnapshot {
  return {
    version: 1,
    tabs: state.tabs.slice(0, WORKSPACE_LIMIT).map((tab) => ({
      id: tab.info.id,
      profile: workspaceProfile(tab.profile)!,
      number: tab.number,
      ordinal: tab.ordinal,
      paneId: tab.paneId,
      directories: directories(tab.directories),
    })),
    panes: state.panes,
    layout: state.layout,
    activePaneId: state.activePaneId,
    localFilerPath,
  };
}
