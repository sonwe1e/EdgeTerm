import { leaf, paneIds, type LayoutNode } from "./layout";
import type { PaneState } from "./storeLayout";
import type { SessionProfile } from "./types";

// Session history is device-local, not a transferable preference. In particular,
// a settings import must never cause connections to another person's servers.
export const WORKSPACE_STORAGE_KEY = "edgeterm.workspace.v1";
/** Where an unreadable snapshot is kept before the first save replaces it. */
export const WORKSPACE_UNREADABLE_KEY = "edgeterm.workspace.v1.unreadable";
/** Where a readable snapshot is kept when the restore could not run in time. */
export const WORKSPACE_SUPERSEDED_KEY = "edgeterm.workspace.v1.superseded";

/**
 * Reads the saved workspace. "Nothing saved" and "saved but unreadable" are
 * different states: the first is a fresh install and needs no explanation, the
 * second means the user's sessions are gone and they deserve to hear why.
 */
export function readSavedWorkspace(storage: Pick<Storage, "getItem">): {
  snapshot: WorkspaceSnapshot | null;
  unreadable: boolean;
} {
  let raw: string | null = null;
  try {
    raw = storage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return { snapshot: null, unreadable: false };
  }
  if (raw === null) return { snapshot: null, unreadable: false };
  try {
    const snapshot = parseWorkspace(raw);
    return { snapshot, unreadable: snapshot === null };
  } catch {
    return { snapshot: null, unreadable: true };
  }
}
const WORKSPACE_LIMIT = 128;

export interface WorkspaceDirectories {
  terminal?: string;
  filer?: string;
  local?: string;
}

interface SavedTab {
  id: string;
  profile: SessionProfile;
  number: number;
  ordinal: number;
  /** The name the user gave the tab, when they gave it one. */
  title?: string;
  /**
   * Pinning is a promise the tab survives closing and reordering, so it has to
   * outlive the window. Omitted when the tab is not pinned, so payloads without
   * a pin keep the shape they had.
   */
  pinned?: boolean;
  /**
   * True when the reader had disconnected this tab before quitting. Restoring
   * such a tab must not dial again: they closed that connection on purpose.
   */
  paused?: boolean;
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
function workspaceProfile(value: unknown): SessionProfile | null {
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
    "jumpProfileIds",
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

/**
 * Drops the panes that no longer hold a tab and keeps the rest of the tree.
 * The saved tabs are cut at `WORKSPACE_LIMIT`, so a large workspace comes back
 * with panes that lost all their tabs; collapsing the whole layout into one pane
 * for that throws away every other split, sizes and all.
 */
function pruneLayout(node: LayoutNode, keep: Set<string>): LayoutNode | null {
  if (node.kind === "leaf") return keep.has(node.paneId) ? node : null;
  const survivors = node.children
    .map((child, index) => ({
      child,
      size: node.sizes[index] ?? 0,
      pruned: pruneLayout(child, keep),
    }))
    .filter((entry) => entry.pruned !== null);
  if (!survivors.length) return null;
  if (survivors.length === 1) return survivors[0].pruned;
  const total = survivors.reduce((sum, entry) => sum + entry.size, 0);
  return {
    kind: "split",
    direction: node.direction,
    children: survivors.map((entry) => entry.pruned as LayoutNode),
    // Sizes have to keep summing to 1 after the drop.
    sizes:
      total > 0
        ? survivors.map((entry) => entry.size / total)
        : survivors.map((_, index) => (index === 0 ? 1 : 0)),
  };
}

/** Every pane id the stored tree names, before anything is dropped. */
function storedPaneIds(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (!object(value) || depth > 16) return out;
  if (value.kind === "leaf" && id(value.paneId)) out.add(value.paneId);
  else if (Array.isArray(value.children)) {
    for (const child of value.children) storedPaneIds(child, out, depth + 1);
  }
  return out;
}

/** A tab name the user set: printable, bounded, and never blank. */
function workspaceTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120 || /[\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  return trimmed;
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
        title: workspaceTitle(item.title),
        pinned: item.pinned === true ? true : undefined,
        paused: item.paused === true ? true : undefined,
        paneId: id(item.paneId) ? item.paneId : "root",
        directories: directories(item.directories),
      });
    }
    const paneSet = new Set(tabs.map((tab) => tab.paneId));
    if (!paneSet.size) paneSet.add("root");
    // Parse against the panes the tree itself names: a pane that lost all its
    // tabs is legal input, and rejecting the whole tree for it is what used to
    // collapse the layout.
    let tree = layout(value.layout, storedPaneIds(value.layout));
    if (tree && paneIds(tree).length !== paneSet.size) {
      // Either the saved tree names a pane with no tab, or a tab names a pane
      // the tree does not have. Drop the empty panes and keep the rest; when a
      // tab is left without a pane, the whole layout still has to collapse.
      const pruned = pruneLayout(tree, paneSet);
      tree = pruned && paneIds(pruned).length === paneSet.size ? pruned : null;
    }
    if (!tree) {
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
      // Omitted entirely when unset, so workspaces without renamed tabs keep
      // the payload they had.
      title: workspaceTitle(tab.title),
      pinned: tab.pinned === true ? true : undefined,
      paused: tab.state === "closed" ? true : undefined,
      paneId: tab.paneId,
      directories: directories(tab.directories),
    })),
    panes: state.panes,
    layout: state.layout,
    activePaneId: state.activePaneId,
    localFilerPath,
  };
}
