import {
  connectSession,
  ensureController,
  newSessionId,
  pendingSessionInfo,
  shellCwd,
} from "./actions";
import type { LayoutNode } from "./layout";
import { useStore, type Tab } from "./store";
import { newPaneId } from "./storeLayout";
import { isFileSession } from "./types";
import { getLocalFilerPath, rememberWorkspaceDirectory } from "./workspaceDirectories";
import {
  parseWorkspace,
  snapshotWorkspace,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceSnapshot,
} from "./workspaceSnapshot";

let saveCurrent = () => {};
const queries = new Map<string, Promise<void>>();

export function captureWorkspaceDirectories(): Promise<void> {
  const tabs = useStore
    .getState()
    .tabs.filter(
      (tab) => tab.state === "connected" && (tab.info.kind === "local" || tab.info.kind === "ssh"),
    );
  const pending = tabs.map((tab) => {
    const id = tab.info.id;
    if (queries.has(id)) return queries.get(id)!;
    const request = shellCwd(tab)
      .then((path) => {
        // A late response after reconnect must not overwrite its new directory.
        const current = useStore.getState().tabs.find((item) => item.info.id === id);
        if (
          current?.state === "connected" &&
          current.info === tab.info &&
          current.directories?.terminal === tab.directories?.terminal
        )
          rememberWorkspaceDirectory(id, "terminal", path);
      })
      .catch(() => {})
      .finally(() => queries.delete(id));
    queries.set(id, request);
    return request;
  });
  return Promise.all(pending).then(() => {});
}

/** Save before the backend kills any shells. A hung server cannot hold Quit forever. */
export async function flushWorkspace(): Promise<void> {
  saveCurrent();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    captureWorkspaceDirectories(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1800);
    }),
  ]);
  clearTimeout(timer);
  saveCurrent();
}

export function restoreWorkspace(snapshot: WorkspaceSnapshot): Tab[] {
  const profiles = useStore.getState().profiles;
  const paneMap = new Map(snapshot.panes.map((pane) => [pane.id, newPaneId()]));
  const idMap = new Map(snapshot.tabs.map((tab) => [tab.id, newSessionId()]));
  const remap = (node: LayoutNode): LayoutNode =>
    node.kind === "leaf"
      ? { ...node, paneId: paneMap.get(node.paneId)! }
      : { ...node, children: node.children.map(remap) };
  const tabs: Tab[] = snapshot.tabs.map((saved) => {
    const profile =
      profiles.find((profile) => profile.id && profile.id === saved.profile.id) ?? saved.profile;
    return {
      info: pendingSessionInfo(idMap.get(saved.id)!, profile),
      profile,
      number: saved.number,
      ordinal: saved.ordinal,
      paneId: paneMap.get(saved.paneId)!,
      directories: saved.directories,
      state: "connecting",
      commandActivity: "idle",
      activityKind: "command",
      cols: 80,
      rows: 24,
    };
  });
  const panes = snapshot.panes.map((pane) => ({
    id: paneMap.get(pane.id)!,
    activeTabId: idMap.get(pane.activeTabId ?? "") ?? null,
  }));
  const activePaneId = paneMap.get(snapshot.activePaneId)!;
  useStore.setState({
    tabs,
    panes,
    layout: remap(snapshot.layout),
    activePaneId,
    activeId: panes.find((pane) => pane.id === activePaneId)?.activeTabId ?? null,
    localFilerPath: snapshot.localFilerPath,
  });
  return tabs;
}

/** Scoped to the App mount, so React StrictMode cannot open every tab twice. */
export function startWorkspace(eventsReady: Promise<unknown>): () => void {
  let stopped = false;
  let ready = false;
  const initialTabs = useStore.getState().tabs;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let previous = "";
  const save = () => {
    if (stopped || !ready) return;
    try {
      const next = JSON.stringify(snapshotWorkspace(useStore.getState(), getLocalFilerPath()));
      if (next === previous) return;
      localStorage.setItem(WORKSPACE_STORAGE_KEY, next);
      previous = next;
    } catch {
      /* Unavailable storage must not prevent working with sessions. */
    }
  };

  void (async () => {
    await eventsReady;
    if (stopped) return;
    const loaded = await useStore.getState().loadProfiles();
    if (stopped || !loaded) return;
    let snapshot: WorkspaceSnapshot | null = null;
    try {
      snapshot = parseWorkspace(localStorage.getItem(WORKSPACE_STORAGE_KEY));
    } catch {}
    // If the user already opened a session while profiles loaded, respect it.
    const restored =
      snapshot && useStore.getState().tabs === initialTabs && initialTabs.length === 0
        ? restoreWorkspace(snapshot)
        : [];
    ready = true;
    saveCurrent = save;
    unsubscribe = useStore.subscribe((state, previous) => {
      if (
        state.tabs !== previous.tabs ||
        state.panes !== previous.panes ||
        state.layout !== previous.layout ||
        state.activePaneId !== previous.activePaneId ||
        state.localFilerPath !== previous.localFilerPath
      )
        save();
    });
    save();
    timer = setInterval(() => {
      void captureWorkspaceDirectories();
    }, 10_000);
    // Connect independently: an MFA prompt or offline host must not stop the
    // other tabs. The tabs and their selection are already in place.
    await Promise.allSettled(
      restored.map(async (tab) => {
        if (!isFileSession(tab.info.kind)) await ensureController(tab.info.id);
        if (stopped || !useStore.getState().tabs.some((item) => item.info.id === tab.info.id))
          return;
        await connectSession(tab.info.id, tab.profile);
      }),
    );
    if (!stopped) await captureWorkspaceDirectories();
  })().catch((error: unknown) => {
    if (!stopped) useStore.getState().setError(String(error));
  });

  return () => {
    save();
    stopped = true;
    unsubscribe();
    clearInterval(timer);
    if (saveCurrent === save) saveCurrent = () => {};
  };
}
