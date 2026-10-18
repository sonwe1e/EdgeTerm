import { Icon } from "../components/icons";
import { useT } from "../useT";
import { formatClock, isRunLive, runCodeId, runStatusKey, runsOf } from "./model";
import type { Experiment, RunRecord, Workspace, WorkspaceData } from "./types";

export function ProjectSidebar({
  data,
  activeWorkspaceId,
  activeExperimentId,
  activeRunId,
  connected,
  onActivateWorkspace,
  onNewProject,
  onEditProject,
  onDeleteProject,
  onActivateExperiment,
  onNewExperiment,
  onEditExperiment,
  onDeleteExperiment,
  onSelectRun,
  onNewRun,
  onConnect,
}: {
  data: WorkspaceData;
  activeWorkspaceId: string | null;
  activeExperimentId: string | null;
  activeRunId: string | null;
  connected: boolean;
  onActivateWorkspace: (id: string) => void;
  onNewProject: () => void;
  onEditProject: (workspace: Workspace) => void;
  onDeleteProject: (workspace: Workspace) => void;
  onActivateExperiment: (id: string | null) => void;
  onNewExperiment: () => void;
  onEditExperiment: (experiment: Experiment) => void;
  onDeleteExperiment: (experiment: Experiment) => void;
  onSelectRun: (run: RunRecord) => void;
  onNewRun: () => void;
  onConnect: () => void;
}) {
  const t = useT();
  const workspace = data.workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const experiments = workspace
    ? data.experiments
        .filter((experiment) => experiment.workspaceId === workspace.id)
        .sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === "baseline" ? -1 : 1))
    : [];
  const runs = workspace ? runsOf(data, workspace.id).slice(0, 8) : [];
  const hasBaseline = experiments.some((experiment) => experiment.kind === "baseline");

  return (
    <aside className="wb-sidebar" aria-label={t("wb.projects")}>
      <div className="wb-sidebar-heading">
        <span>{t("wb.projects")}</span>
        <button type="button" className="wb-icon-button" title={t("wb.newProject")} onClick={onNewProject}>
          <Icon name="add" />
        </button>
      </div>
      <div className="wb-project-list">
        {data.workspaces.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`wb-project${item.id === activeWorkspaceId ? " is-active" : ""}`}
            onClick={() => onActivateWorkspace(item.id)}
            title={`${item.server.name} · ${item.server.host}\n${item.root}`}
          >
            <span className="wb-project-name">{item.name}</span>
            <span className="wb-project-meta">
              {item.server.username}@{item.server.host}:{item.server.port}
            </span>
            <span className="wb-project-root">{item.root}</span>
          </button>
        ))}
        {data.workspaces.length === 0 && (
          <p className="wb-sidebar-note">{t("wb.noProjectsHint")}</p>
        )}
      </div>

      {workspace && (
        <div className="wb-sidebar-section">
          <div className="wb-sidebar-section-head">
            <strong>{t("wb.server")}</strong>
            {!connected && (
              <button type="button" className="btn wb-mini" onClick={onConnect}>
                {t("wb.connect")}
              </button>
            )}
            {connected && <span className="wb-connected">{t("wb.connected")}</span>}
          </div>
          <div className="wb-identity">
            <Icon name="server" />
            <span>
              {workspace.server.name || workspace.server.host} · {workspace.server.username}@
              {workspace.server.host}:{workspace.server.port}
            </span>
          </div>
          <div className="wb-identity">
            <Icon name="folder" />
            <span title={workspace.root}>{workspace.root}</span>
          </div>
          {!connected && <p className="wb-sidebar-note">{t("wb.connectHint")}</p>}
          <div className="wb-sidebar-actions">
            <button type="button" className="btn wb-mini" onClick={() => onEditProject(workspace)}>
              {t("wb.edit")}
            </button>
            <button type="button" className="btn wb-mini" onClick={() => onDeleteProject(workspace)}>
              {t("common.delete")}
            </button>
          </div>
        </div>
      )}

      {workspace && (
        <div className="wb-sidebar-section">
          <div className="wb-sidebar-section-head">
            <strong>{t("wb.experiments")}</strong>
            <button
              type="button"
              className="wb-icon-button"
              title={t("wb.newExperiment")}
              onClick={onNewExperiment}
            >
              <Icon name="add" />
            </button>
          </div>
          {experiments.length === 0 ? (
            <p className="wb-sidebar-note">{t("wb.noExperimentsHint")}</p>
          ) : (
            experiments.map((experiment) => (
              <div
                key={experiment.id}
                className={`wb-experiment${experiment.id === activeExperimentId ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className="wb-experiment-main"
                  onClick={() => onActivateExperiment(experiment.id)}
                  title={`${experiment.name}${experiment.root ? ` · ${experiment.root}` : ""}`}
                >
                  <span className={`wb-badge is-${experiment.kind}`}>
                    {experiment.kind === "baseline" ? t("wb.baseline") : t("wb.variant")}
                  </span>
                  <span>
                    <strong>{experiment.name}</strong>
                    <small>
                      {experiment.root ?? workspace.root}
                      {experiment.branch ? ` · ${experiment.branch}` : ""}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="wb-icon-button"
                  aria-label={t("wb.editExperiment")}
                  onClick={() => onEditExperiment(experiment)}
                >
                  <Icon name="edit" />
                </button>
                <button
                  type="button"
                  className="wb-icon-button"
                  aria-label={t("wb.deleteExperimentTitle")}
                  onClick={() => onDeleteExperiment(experiment)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))
          )}
          {experiments.length > 0 && !hasBaseline && (
            <p className="wb-sidebar-warning">{t("wb.baselineRequired")}</p>
          )}
          <button type="button" className="btn wb-mini" onClick={onNewExperiment}>
            <Icon name="add" /> {t("wb.newExperiment")}
          </button>
        </div>
      )}

      {workspace && (
        <div className="wb-sidebar-section wb-runs-section">
          <div className="wb-sidebar-section-head">
            <strong>{t("wb.recentRuns")}</strong>
            <button
              type="button"
              className="wb-icon-button"
              title={t("wb.newRun")}
              disabled={experiments.length === 0}
              onClick={onNewRun}
            >
              <Icon name="play" />
            </button>
          </div>
          {runs.length === 0 ? (
            <p className="wb-sidebar-note">{t("wb.noRuns")}</p>
          ) : (
            runs.map((run) => {
              const experiment = data.experiments.find((item) => item.id === run.experimentId);
              return (
                <button
                  type="button"
                  key={run.id}
                  className={`wb-run-row${run.id === activeRunId ? " is-active" : ""}`}
                  onClick={() => onSelectRun(run)}
                  title={`${run.command}\n${run.runDir}`}
                >
                  <span className={`wb-run-dot is-${run.status}${isRunLive(run.status) ? " is-live" : ""}`} />
                  <span className="wb-run-main">
                    <span>{experiment?.name ?? t("wb.experiment")}</span>
                    <small>
                      {t(runStatusKey(run.status))} · {runCodeId(run)} · {formatClock(run.startedAt)}
                    </small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </aside>
  );
}
