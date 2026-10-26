import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/icons";
import { ContextMenu } from "../components/ContextMenu";
import { ModalDialog } from "../components/ModalDialog";
import { errorText } from "../errorInfo";
import { useStore } from "../store";
import { getController } from "../terminalRegistry";
import { useT } from "../useT";
import { CompareDialog } from "./CompareDialog";
import { DraftsDialog } from "./DraftsDialog";
import { EditorArea } from "./EditorArea";
import { ExperimentDialog } from "./ExperimentDialog";
import { ExplorerPanel } from "./ExplorerPanel";
import { GitDiffDialog } from "./GitDiffDialog";
import { HostStrip } from "./HostStrip";
import { ProjectSearch } from "./ProjectSearch";
import { ProjectSidebar } from "./ProjectSidebar";
import { QuickOpen } from "./QuickOpen";
import { RunConsole } from "./RunConsole";
import { RunDialog, type RunInput } from "./RunDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { experimentRoot, experimentsOf, isRunLive, runsOf } from "./model";
import { connectedTabFor, shellQuote } from "./session";
import { useWorkbench } from "./store";
import type { Experiment, RunRecord, Workspace } from "./types";

export function Workbench() {
  const t = useT();
  // A string selector: the workbench re-renders when a session connects or
  // closes, not on every tab resize or command-state change.
  const connectionSignature = useStore((state) =>
    state.tabs.map((tab) => `${tab.info.id}:${tab.state}:${tab.info.profileId ?? ""}`).join("|"),
  );
  const data = useWorkbench((state) => state.data);
  const status = useWorkbench((state) => state.status);
  const loadError = useWorkbench((state) => state.error);
  const activeWorkspaceId = useWorkbench((state) => state.activeWorkspaceId);
  const activeExperimentId = useWorkbench((state) => state.activeExperimentId);
  const activeRunId = useWorkbench((state) => state.activeRunId);
  const notice = useWorkbench((state) => state.notice);
  const drafts = useWorkbench((state) => state.drafts);
  const draftsOpen = useWorkbench((state) => state.draftsOpen);
  const setDraftsOpen = useWorkbench((state) => state.setDraftsOpen);
  const files = useWorkbench((state) => state.files);
  const filesErrors = useWorkbench((state) => state.filesErrors);
  const init = useWorkbench((state) => state.init);
  const setView = useWorkbench((state) => state.setView);
  const setNotice = useWorkbench((state) => state.setNotice);
  const activateWorkspace = useWorkbench((state) => state.activateWorkspace);
  const activateExperiment = useWorkbench((state) => state.activateExperiment);
  const setActiveRun = useWorkbench((state) => state.setActiveRun);
  const saveWorkspace = useWorkbench((state) => state.saveWorkspace);
  const deleteWorkspace = useWorkbench((state) => state.deleteWorkspace);
  const saveExperiment = useWorkbench((state) => state.saveExperiment);
  const deleteExperiment = useWorkbench((state) => state.deleteExperiment);
  const openFile = useWorkbench((state) => state.openFile);
  const connect = useWorkbench((state) => state.connect);
  const openTerminal = useWorkbench((state) => state.openTerminal);
  const startRun = useWorkbench((state) => state.startRun);
  const refreshRun = useWorkbench((state) => state.refreshRun);
  const stopRun = useWorkbench((state) => state.stopRun);
  const refreshFiles = useWorkbench((state) => state.refreshFiles);
  void connectionSignature;

  const workspace = data.workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const experiments = workspace ? experimentsOf(data, workspace.id) : [];
  const experiment =
    experiments.find((item) => item.id === activeExperimentId) ?? experiments[0] ?? null;
  const root = workspace ? experimentRoot(workspace, experiment) : "";
  const connected = workspace ? Boolean(connectedTabFor(workspace.server)) : false;
  const sessionId = workspace ? (connectedTabFor(workspace.server)?.info.id ?? null) : null;
  const listing = files[`${workspace?.id}:${root}`] ?? null;
  const runs = workspace ? runsOf(data, workspace.id) : [];
  const run = data.runs.find((item) => item.id === activeRunId) ?? runs[0] ?? null;

  const [projectDialog, setProjectDialog] = useState<{ workspace: Workspace | null } | null>(null);
  const [experimentDialog, setExperimentDialog] = useState<{
    experiment: Experiment | null;
  } | null>(null);
  const [runDialog, setRunDialog] = useState<{
    prefill: { command: string; env: string; gpu: string; resumedFrom: string } | null;
  } | null>(null);
  const [comparePath, setComparePath] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "workspace"; workspace: Workspace }
    | { kind: "experiment"; experiment: Experiment }
    | null
  >(null);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [compactView, setCompactView] = useState<"projects" | "files" | "editor">("editor");
  const bodyRef = useRef<HTMLDivElement>(null);
  const browseFiles = () => {
    setCompactView("files");
    requestAnimationFrame(() =>
      bodyRef.current
        ?.querySelector<HTMLElement>(".wb-explorer input, .wb-explorer button")
        ?.focus(),
    );
  };

  useEffect(() => {
    void init();
  }, [init]);

  // Mod+P / Mod+Shift+F / Mod+S inside the workbench. CodeMirror owns the
  // keys while it has focus; these cover the rest of the workspace. A dialog
  // or a form field keeps its own behaviour.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("dialog[open], input, textarea, select")) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        const state = useWorkbench.getState();
        const current = state.data.workspaces.find((item) => item.id === state.activeWorkspaceId);
        if (current) void state.refreshFiles(current.id);
        setQuickOpenOpen(true);
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (key === "s") {
        event.preventDefault();
        const state = useWorkbench.getState();
        if (state.activeDocId) void state.saveDoc(state.activeDocId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A cheap size/mtime probe for the open file. It never downloads content:
  // the hash check on save stays the authority, and a stat is enough to tell
  // the user that the server copy moved.
  const activeDocId = useWorkbench((state) => state.activeDocId);
  useEffect(() => {
    if (activeDocId) setCompactView("editor");
  }, [activeDocId]);
  useEffect(() => {
    if (!activeDocId) return;
    const check = () => {
      if (!document.hidden) void useWorkbench.getState().checkRemoteDoc(activeDocId);
    };
    const timer = setInterval(check, 10_000);
    const onVisible = () => check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeDocId]);

  const liveSignature = data.runs
    .filter((item) => isRunLive(item.status))
    .map((item) => item.id)
    .join(",");
  useEffect(() => {
    if (!liveSignature) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      for (const id of liveSignature.split(",")) {
        await refreshRun(id);
      }
      if (!stopped) timer = setTimeout(() => void tick(), 4000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [liveSignature, refreshRun]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  const quickFiles = listing;
  const quickError = workspace ? (filesErrors[`${workspace.id}:${root}`] ?? null) : null;

  const openQuickOpen = () => {
    if (!workspace) {
      setNotice(t("wb.openProjectFirst"));
      return;
    }
    if (!listing) void refreshFiles(workspace.id);
    setQuickOpenOpen(true);
  };

  const open = (path: string, line?: number) => {
    if (!workspace || !experiment) return;
    void openFile(workspace.id, experiment.id, path, line);
    setCompactView("editor");
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(".wb-center")?.focus());
  };

  const handleCompare = (path: string) => {
    setComparePath(path);
  };

  const handleAttach = async (target: RunRecord) => {
    if (target.mode !== "tmux") {
      setNotice(t("wb.attachDetached"));
      return;
    }
    try {
      await openTerminal(target.workspaceId);
      const tab = useStore
        .getState()
        .tabs.find((item) => item.workspaceId === target.workspaceId && item.state === "connected");
      if (tab)
        getController(tab.info.id)?.writeText(`tmux attach -t ${shellQuote(target.taskName)}\n`);
      setView("terminals");
      setNotice(t("wb.terminalOpened", { root: target.root }));
    } catch (error) {
      setNotice(errorText(error));
    }
  };

  const handleStart = async (input: RunInput) => {
    if (!workspace) return;
    const created = await startRun({
      workspaceId: workspace.id,
      experimentId: input.experimentId,
      command: input.command,
      env: input.env,
      gpu: input.gpu,
      snapshot: input.snapshot,
      excludes: input.excludes,
      execution: input.execution,
      links: input.links,
      allowUnsynced: input.allowUnsynced,
      resumedFrom: runDialog?.prefill?.resumedFrom ?? null,
    });
    setRunDialog(null);
    setNotice(created.status === "unknown" ? t("wb.runUncertain") : t("wb.runStarted"));
    setActiveRun(created.id);
    setTimeout(() => void refreshRun(created.id), 1200);
  };

  if (status === "loading" || status === "idle") {
    return <div className="wb wb-loading">{t("wb.loading")}</div>;
  }
  if (status === "error") {
    return (
      <div className="wb wb-loading">
        <h2>{t("wb.errorTitle")}</h2>
        <p>{loadError}</p>
        <button type="button" className="btn" onClick={() => void init()}>
          {t("wb.refresh")}
        </button>
      </div>
    );
  }

  return (
    <div className="wb">
      <Header
        workspace={workspace}
        experiment={experiment}
        experiments={experiments}
        connected={connected}
        draftCount={drafts.length}
        onActivateExperiment={activateExperiment}
        onNewProject={() => setProjectDialog({ workspace: null })}
        onNewRun={() => {
          if (!workspace) return;
          if (!experiment) {
            setNotice(t("wb.runNoExperiment"));
            setExperimentDialog({ experiment: null });
            return;
          }
          setRunDialog({ prefill: null });
        }}
        onOpenTerminal={() => {
          if (!workspace) return;
          void openTerminal(workspace.id)
            .then(() => setView("terminals"))
            .catch((error) => setNotice(errorText(error)));
        }}
        onQuickOpen={openQuickOpen}
        onSearch={() => setSearchOpen(true)}
        onDrafts={() => setDraftsOpen(true)}
        onTerminals={() => setView("terminals")}
      />

      {data.workspaces.length === 0 ? (
        <div className="wb-onboarding">
          <Icon name="server" />
          <h2>{t("wb.noProjects")}</h2>
          <p>{t("wb.noProjectsHint")}</p>
          <button
            type="button"
            className="btn is-primary"
            onClick={() => setProjectDialog({ workspace: null })}
          >
            {t("wb.createFirst")}
          </button>
        </div>
      ) : (
        <>
          <HostStrip />
          <nav className="wb-compact-nav" aria-label={t("wb.title")}>
            <button
              type="button"
              aria-pressed={compactView === "projects"}
              onClick={() => setCompactView("projects")}
            >
              {t("wb.projectDetails")}
            </button>
            <button
              type="button"
              aria-pressed={compactView === "files"}
              disabled={!workspace || !experiment}
              onClick={browseFiles}
            >
              {t("wb.browseFiles")}
            </button>
            <button
              type="button"
              aria-pressed={compactView === "editor"}
              onClick={() => setCompactView("editor")}
            >
              {t("wb.showEditor")}
            </button>
          </nav>
          <div className="wb-body" data-view={compactView} ref={bodyRef}>
            <ProjectSidebar
              data={data}
              activeWorkspaceId={workspace?.id ?? null}
              activeExperimentId={experiment?.id ?? null}
              activeRunId={run?.id ?? null}
              connected={connected}
              onActivateWorkspace={activateWorkspace}
              onNewProject={() => setProjectDialog({ workspace: null })}
              onEditProject={(item) => setProjectDialog({ workspace: item })}
              onDeleteProject={(item) => setPendingDelete({ kind: "workspace", workspace: item })}
              onActivateExperiment={activateExperiment}
              onNewExperiment={() => setExperimentDialog({ experiment: null })}
              onEditExperiment={(item) => setExperimentDialog({ experiment: item })}
              onDeleteExperiment={(item) =>
                setPendingDelete({ kind: "experiment", experiment: item })
              }
              onSelectRun={(item) => setActiveRun(item.id)}
              onNewRun={() => {
                if (!workspace) return;
                if (!experiment) {
                  setNotice(t("wb.runNoExperiment"));
                  setExperimentDialog({ experiment: null });
                  return;
                }
                setRunDialog({ prefill: null });
              }}
              onConnect={() => {
                if (!workspace) return;
                void connect(workspace.id);
              }}
            />
            <main className="wb-center" tabIndex={-1}>
              {workspace && !connected && (
                <div className="wb-banner is-warning">
                  <span>{t("wb.connectHint")}</span>
                  <button
                    type="button"
                    className="btn is-primary"
                    onClick={() => void connect(workspace.id)}
                  >
                    {t("wb.connect")}
                  </button>
                </div>
              )}
              <EditorArea
                onBrowseFiles={workspace && experiment ? browseFiles : undefined}
                onQuickOpen={openQuickOpen}
                onSearch={() => setSearchOpen(true)}
                onCompare={handleCompare}
              />
            </main>
            {workspace && experiment && (
              <ExplorerPanel
                workspace={workspace}
                root={root}
                connected={connected}
                onOpenFile={(path) => open(path)}
                onCompare={handleCompare}
                onDiff={(path) => setDiffPath(path)}
              />
            )}
          </div>
          <RunConsole
            run={run}
            onStop={(id) => {
              void stopRun(id).catch((error) => setNotice(errorText(error)));
            }}
            onAttach={(target) => void handleAttach(target)}
            onResume={(target) => {
              if (!workspace) return;
              setActiveRun(target.id);
              setRunDialog({
                prefill: {
                  command: target.command,
                  env: target.env,
                  gpu: target.gpu,
                  resumedFrom: target.id,
                },
              });
            }}
          />
        </>
      )}

      {notice && (
        <div className="wb-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="wb-icon-button"
            aria-label={t("common.close")}
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      {projectDialog && (
        <WorkspaceDialog
          workspace={projectDialog.workspace}
          onClose={() => setProjectDialog(null)}
          onSubmit={async (input) => {
            await saveWorkspace(input);
            setProjectDialog(null);
            setNotice(t("wb.projectSaved"));
          }}
        />
      )}

      {experimentDialog && workspace && (
        <ExperimentDialog
          workspace={workspace}
          experiments={experiments}
          experiment={experimentDialog.experiment}
          onClose={() => setExperimentDialog(null)}
          onSubmit={async (input) => {
            await saveExperiment(input);
            setExperimentDialog(null);
            setNotice(t("wb.experimentSaved"));
          }}
        />
      )}

      {runDialog && workspace && experiment && (
        <RunDialog
          workspace={workspace}
          experiments={experiments}
          initialExperimentId={experiment.id}
          prefill={runDialog.prefill}
          onClose={() => setRunDialog(null)}
          onSubmit={handleStart}
        />
      )}

      {draftsOpen && <DraftsDialog onClose={() => setDraftsOpen(false)} />}

      {comparePath && workspace && experiment && (
        <CompareDialog
          data={data}
          initialWorkspaceId={workspace.id}
          initialExperimentId={experiment.id}
          initialPath={comparePath}
          onClose={() => setComparePath(null)}
        />
      )}

      {diffPath && workspace && (
        <GitDiffDialog
          sessionId={sessionId}
          root={root}
          path={diffPath}
          onClose={() => setDiffPath(null)}
        />
      )}

      {quickOpenOpen && (
        <QuickOpen
          files={quickFiles}
          error={quickError}
          onRetry={() => void refreshFiles(workspace!.id)}
          onOpen={(path) => open(path)}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}

      {searchOpen && (
        <ProjectSearch
          sessionId={sessionId}
          root={root}
          onOpen={(path, line) => open(path, line)}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {pendingDelete && (
        <ModalDialog
          open
          role="alertdialog"
          contentClassName="confirm-dialog"
          onClose={() => setPendingDelete(null)}
        >
          <div className="dialog-header">
            {pendingDelete.kind === "workspace"
              ? t("wb.deleteProjectTitle")
              : t("wb.deleteExperimentTitle")}
          </div>
          <div className="dialog-body confirm-dialog-body">
            <p>
              {pendingDelete.kind === "workspace"
                ? t("wb.deleteProjectBody", { name: pendingDelete.workspace.name })
                : t("wb.deleteExperimentBody", { name: pendingDelete.experiment.name })}
            </p>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn" onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn is-primary"
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target.kind === "workspace") {
                  void deleteWorkspace(target.workspace.id)
                    .then(() => setNotice(t("wb.projectDeleted")))
                    .catch((error) => setNotice(errorText(error)));
                } else {
                  void deleteExperiment(target.experiment.id).catch((error) =>
                    setNotice(errorText(error)),
                  );
                }
              }}
            >
              {t("common.delete")}
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

function Header({
  workspace,
  experiment,
  experiments,
  connected,
  draftCount,
  onActivateExperiment,
  onNewProject,
  onNewRun,
  onOpenTerminal,
  onQuickOpen,
  onSearch,
  onDrafts,
  onTerminals,
}: {
  workspace: Workspace | null;
  experiment: Experiment | null;
  experiments: Experiment[];
  connected: boolean;
  draftCount: number;
  onActivateExperiment: (id: string) => void;
  onNewProject: () => void;
  onNewRun: () => void;
  onOpenTerminal: () => void;
  onQuickOpen: () => void;
  onSearch: () => void;
  onDrafts: () => void;
  onTerminals: () => void;
}) {
  const t = useT();
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  return (
    <header className="wb-top">
      <div className="wb-top-title">
        <Icon name="circuit-board" />
        <strong>{t("wb.title")}</strong>
      </div>
      {workspace && (
        <div className="wb-top-context">
          <span className="wb-project-name">{workspace.name}</span>
          <span className={`wb-server-chip${connected ? " is-online" : ""}`} title={workspace.root}>
            {workspace.server.username}@{workspace.server.host}:{workspace.server.port}
          </span>
          {experiments.length > 0 && (
            <select
              value={experiment?.id ?? ""}
              aria-label={t("wb.experiment")}
              onChange={(event) => onActivateExperiment(event.target.value)}
            >
              {experiments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.kind === "baseline" ? t("wb.baseline") : t("wb.variant")}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="wb-top-actions">
        <button
          type="button"
          className={`btn wb-mini${workspace ? " wb-secondary" : ""}`}
          onClick={onNewProject}
        >
          <Icon name="add" /> {t("wb.newProject")}
        </button>
        <button
          type="button"
          className={`btn wb-mini${workspace ? "" : " wb-secondary"}`}
          disabled={!workspace}
          onClick={onNewRun}
        >
          <Icon name="play" /> {t("wb.newRun")}
        </button>
        <button
          type="button"
          className="wb-icon-button wb-secondary"
          title={t("wb.quickOpen")}
          disabled={!workspace}
          onClick={onQuickOpen}
        >
          <Icon name="search" />
        </button>
        <button
          type="button"
          className="wb-icon-button wb-secondary"
          title={t("wb.search")}
          disabled={!workspace}
          onClick={onSearch}
        >
          <Icon name="find-in-files" />
        </button>
        <button
          type="button"
          className="btn wb-mini wb-secondary"
          disabled={!workspace}
          onClick={onOpenTerminal}
        >
          <Icon name="terminal" /> {t("wb.openTerminal")}
        </button>
        <button
          type="button"
          className={`btn wb-mini wb-secondary${draftCount > 0 ? " is-attention" : ""}`}
          title={t("wb.draftsHint")}
          onClick={onDrafts}
        >
          {t("wb.drafts")}
          {draftCount > 0 ? <span className="wb-count">{draftCount}</span> : null}
        </button>
        <button type="button" className="btn wb-mini" onClick={onTerminals}>
          {t("wb.backToTerminals")}
        </button>
        <button
          type="button"
          className={`wb-icon-button wb-more${draftCount > 0 ? " is-attention" : ""}`}
          aria-label={t("wb.moreActions")}
          title={t("wb.moreActions")}
          aria-haspopup="menu"
          aria-expanded={more !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMore(more ? null : { x: rect.right, y: rect.bottom });
          }}
        >
          <Icon name="ellipsis" />
        </button>
      </div>
      {more && (
        <ContextMenu
          {...more}
          align="right"
          onClose={() => setMore(null)}
          items={[
            { label: t("wb.newProject"), icon: "add", action: onNewProject },
            { label: t("wb.quickOpen"), icon: "search", disabled: !workspace, action: onQuickOpen },
            {
              label: t("wb.search"),
              icon: "find-in-files",
              disabled: !workspace,
              action: onSearch,
            },
            {
              label: t("wb.openTerminal"),
              icon: "terminal",
              disabled: !workspace,
              action: onOpenTerminal,
            },
            {
              label: `${t("wb.drafts")}${draftCount > 0 ? ` (${draftCount})` : ""}`,
              action: onDrafts,
            },
          ]}
        />
      )}
    </header>
  );
}
