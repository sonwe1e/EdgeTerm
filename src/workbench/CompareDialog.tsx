import { useMemo, useState } from "react";
import type { FileComparison } from "../api";
import { FileDiffView } from "../components/FileDiffView";
import { ModalDialog } from "../components/ModalDialog";
import { errorText } from "../errorInfo";
import { useT } from "../useT";
import * as wb from "./api";
import { experimentRoot, joinRemote } from "./model";
import { connectedTabFor } from "./session";
import type { Workspace, WorkspaceData } from "./types";

/**
 * Compares one file across two projects (or two experiments of one project).
 * The default is the same relative path on both sides, which is how a
 * baseline and an ablation are usually put side by side; either side can be
 * pointed elsewhere.
 */
export function CompareDialog({
  data,
  initialWorkspaceId,
  initialExperimentId,
  initialPath,
  onClose,
}: {
  data: WorkspaceData;
  initialWorkspaceId: string;
  initialExperimentId: string | null;
  initialPath: string;
  onClose: () => void;
}) {
  const t = useT();
  const workspaces = data.workspaces;
  const [leftWorkspace, setLeftWorkspace] = useState(initialWorkspaceId);
  const [leftExperiment, setLeftExperiment] = useState(initialExperimentId ?? "");
  const [rightWorkspace, setRightWorkspace] = useState(
    workspaces.find((item) => item.id !== initialWorkspaceId)?.id ?? initialWorkspaceId,
  );
  const [rightExperiment, setRightExperiment] = useState("");
  const [path, setPath] = useState(initialPath);
  const [rightPath, setRightPath] = useState("");
  const [comparison, setComparison] = useState<FileComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const experimentsFor = (workspaceId: string) =>
    data.experiments.filter((experiment) => experiment.workspaceId === workspaceId);

  const left = workspaces.find((item) => item.id === leftWorkspace) ?? workspaces[0];
  const right = workspaces.find((item) => item.id === rightWorkspace) ?? workspaces[0];

  const sides = useMemo(() => {
    const build = (
      workspace: Workspace | undefined,
      experimentId: string,
    ): { root: string; session: string | null; server: string } | null => {
      if (!workspace) return null;
      const experiment =
        data.experiments.find((item) => item.id === experimentId) ?? null;
      return {
        root: experimentRoot(workspace, experiment),
        session: connectedTabFor(workspace.server)?.info.id ?? null,
        server: workspace.name,
      };
    };
    return {
      left: build(left, leftExperiment),
      right: build(right, rightExperiment),
    };
  }, [data.experiments, left, right, leftExperiment, rightExperiment]);

  const run = async () => {
    if (!path.trim()) return;
    if (!sides.left?.session || !sides.right?.session) {
      setError(t("wb.noSession"));
      return;
    }
    setBusy(true);
    setError(null);
    setComparison(null);
    try {
      const found = await wb.compare(
        sides.left.session,
        joinRemote(sides.left.root, path.trim()),
        sides.right.session,
        joinRemote(sides.right.root, (rightPath.trim() || path).trim()),
      );
      setComparison(found);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open
      onClose={onClose}
      ariaLabel={t("wb.compareTitle")}
      contentClassName="wb-compare-dialog"
    >
      <div className="wb-dialog-header">
        <strong>{t("wb.compareTitle")}</strong>
        <button type="button" className="wb-icon-button" aria-label={t("wb.close")} onClick={onClose}>
          ×
        </button>
      </div>
      <p className="wb-dialog-note">{t("wb.compareHint")}</p>
      <div className="wb-compare-form">
        <SideForm
          label={t("wb.left")}
          workspaces={workspaces}
          experimentsFor={experimentsFor}
          workspaceId={leftWorkspace}
          experimentId={leftExperiment}
          onWorkspace={(id) => {
            setLeftWorkspace(id);
            setLeftExperiment("");
          }}
          onExperiment={setLeftExperiment}
        />
        <SideForm
          label={t("wb.right")}
          workspaces={workspaces}
          experimentsFor={experimentsFor}
          workspaceId={rightWorkspace}
          experimentId={rightExperiment}
          onWorkspace={(id) => {
            setRightWorkspace(id);
            setRightExperiment("");
          }}
          onExperiment={setRightExperiment}
        />
        <label className="wb-field">
          <span>{t("wb.file")}</span>
          <input
            value={path}
            placeholder="src/model.py"
            spellCheck={false}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void run();
            }}
          />
        </label>
        <label className="wb-field">
          <span>{t("wb.right")} · {t("wb.file")}</span>
          <input
            value={rightPath}
            placeholder={path || "src/model.py"}
            spellCheck={false}
            onChange={(event) => setRightPath(event.target.value)}
          />
        </label>
      </div>
      <div className="wb-dialog-actions">
        <span className="wb-compare-context">
          {sides.left && `${sides.left.server}: ${joinRemote(sides.left.root, path || "…")}`}
        </span>
        <button type="button" className="btn is-primary" disabled={busy || !path.trim()} onClick={() => void run()}>
          {busy ? t("wb.loading") : t("wb.compare")}
        </button>
      </div>
      {error && <p className="wb-dialog-error">{error}</p>}
      {comparison && (
        <div className="wb-compare-result">
          <div className="wb-compare-paths">
            <span>{comparison.left.kind} · {comparison.left.size} B</span>
            <span>{comparison.right.kind} · {comparison.right.size} B</span>
          </div>
          {comparison.reason && <p className="wb-dialog-note">{comparison.reason}</p>}
          <FileDiffView key={`${path}:${rightPath}:${comparison.left.sha256 ?? ""}`} rows={comparison.rows} />
        </div>
      )}
    </ModalDialog>
  );
}

function SideForm({
  label,
  workspaces,
  experimentsFor,
  workspaceId,
  experimentId,
  onWorkspace,
  onExperiment,
}: {
  label: string;
  workspaces: Workspace[];
  experimentsFor: (workspaceId: string) => WorkspaceData["experiments"];
  workspaceId: string;
  experimentId: string;
  onWorkspace: (id: string) => void;
  onExperiment: (id: string) => void;
}) {
  const t = useT();
  const experiments = experimentsFor(workspaceId);
  return (
    <div className="wb-side-form">
      <strong>{label}</strong>
      <label className="wb-field">
        <span>{t("wb.workspace")}</span>
        <select value={workspaceId} onChange={(event) => onWorkspace(event.target.value)}>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>
      <label className="wb-field">
        <span>{t("wb.experiment")}</span>
        <select value={experimentId} onChange={(event) => onExperiment(event.target.value)}>
          <option value="">—</option>
          {experiments.map((experiment) => (
            <option key={experiment.id} value={experiment.id}>
              {experiment.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
