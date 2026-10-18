import { useState } from "react";
import { ModalDialog } from "../components/ModalDialog";
import { errorText } from "../errorInfo";
import { useT } from "../useT";
import { defaultCommand, experimentRoot } from "./model";
import { useWorkbench } from "./store";
import type { ExecutionMode, Experiment, SnapshotMode, Workspace } from "./types";

export interface RunInput {
  experimentId: string;
  command: string;
  env: string;
  gpu: string;
  snapshot: SnapshotMode;
  excludes: string[];
  execution: ExecutionMode;
  links: string[];
  allowUnsynced: boolean;
}

export function RunDialog({
  workspace,
  experiments,
  initialExperimentId,
  prefill,
  onClose,
  onSubmit,
}: {
  workspace: Workspace;
  experiments: Experiment[];
  initialExperimentId: string | null;
  prefill?: { command: string; env: string; gpu: string; resumedFrom: string } | null;
  onClose: () => void;
  onSubmit: (input: RunInput) => Promise<void>;
}) {
  const t = useT();
  const probe = useWorkbench((state) => state.probes[workspace.id]);
  const docs = useWorkbench((state) => state.docs);
  const saved = defaultCommand(workspace);
  const [experimentId, setExperimentId] = useState(
    initialExperimentId ?? experiments[0]?.id ?? "",
  );
  const [command, setCommand] = useState(prefill?.command ?? saved?.command ?? "");
  const [env, setEnv] = useState(prefill?.env ?? workspace.env);
  const [gpu, setGpu] = useState(prefill?.gpu ?? "");
  const [snapshot, setSnapshot] = useState(true);
  const [excludes, setExcludes] = useState("");
  const [execution, setExecution] = useState<ExecutionMode>("workspace");
  const [links, setLinks] = useState("");
  const [allowUnsynced, setAllowUnsynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const experiment = experiments.find((item) => item.id === experimentId) ?? null;
  const runRoot = experimentRoot(workspace, experiment).replace(/\/+$/, "");
  // The editor's own view of what is not on the server yet. A run executes
  // the server copies, so these files would silently be one version behind.
  const unsynced = docs
    .filter(
      (doc) =>
        doc.workspaceId === workspace.id &&
        doc.content !== doc.savedContent &&
        (doc.absolutePath === runRoot || doc.absolutePath.startsWith(`${runRoot}/`)),
    )
    .map((doc) => doc.path);

  const submit = async () => {
    if (!experimentId) {
      setError(t("wb.runNoExperiment"));
      return;
    }
    if (!command.trim()) {
      setError(t("wb.commandRequired"));
      return;
    }
    if (execution === "isolated" && !snapshot) {
      setError(t("wb.isolatedNeedsSnapshot"));
      return;
    }
    if (unsynced.length > 0 && !allowUnsynced) {
      setError(t("wb.runUnsyncedBlocked", { count: String(unsynced.length) }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        experimentId,
        command: command.trim(),
        env,
        gpu: gpu.trim(),
        snapshot: execution === "isolated" ? "code" : snapshot ? "code" : "none",
        excludes: excludes
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        execution,
        links: links
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
        allowUnsynced,
      });
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <ModalDialog open onClose={onClose} ariaLabel={t("wb.newRun")} contentClassName="wb-form-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="wb-dialog-header">
          <strong>{t("wb.newRun")}</strong>
          <button type="button" className="wb-icon-button" aria-label={t("common.close")} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="wb-form">
          <p className="wb-dialog-note">
            {workspace.name} · {workspace.server.username}@{workspace.server.host}:
            {workspace.server.port} · {workspace.root}
          </p>
          <label className="wb-field">
            <span>{t("wb.experiment")}</span>
            <select value={experimentId} onChange={(event) => setExperimentId(event.target.value)}>
              {experiments.map((experiment) => (
                <option key={experiment.id} value={experiment.id}>
                  {experiment.name} ({experiment.kind === "baseline" ? t("wb.baseline") : t("wb.variant")})
                </option>
              ))}
            </select>
          </label>
          {workspace.commands.length > 0 && (
            <label className="wb-field">
              <span>{t("wb.commands")}</span>
              <select
                value=""
                onChange={(event) => {
                  const chosen = workspace.commands.find((item) => item.id === event.target.value);
                  if (chosen) {
                    setCommand(chosen.command);
                    if (chosen.kind === "train") setSnapshot(true);
                  }
                }}
              >
                <option value="">{t("wb.runCommand")}</option>
                {workspace.commands.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="wb-field">
            <span>{t("wb.runCommand")}</span>
            <textarea
              autoFocus
              rows={3}
              value={command}
              spellCheck={false}
              placeholder="python train.py --config configs/base.yaml"
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <label className="wb-field">
            <span>{t("wb.runEnv")}</span>
            <textarea
              rows={2}
              value={env}
              spellCheck={false}
              placeholder="conda activate vfi"
              onChange={(event) => setEnv(event.target.value)}
            />
          </label>
          <label className="wb-field">
            <span>{t("wb.runGpu")}</span>
            <input value={gpu} placeholder="0,1" onChange={(event) => setGpu(event.target.value)} />
            <small>{t("wb.runGpuHint")}</small>
          </label>
          <label className="wb-check">
            <input
              type="checkbox"
              checked={snapshot}
              onChange={(event) => setSnapshot(event.target.checked)}
            />
            <span>
              {t("wb.runSnapshot")}
              <small>{t("wb.runSnapshotHint")}</small>
            </span>
          </label>
          <label className="wb-field">
            <span>{t("wb.runExcludes")}</span>
            <input
              value={excludes}
              spellCheck={false}
              placeholder="data, ckpt, vendor"
              onChange={(event) => setExcludes(event.target.value)}
            />
            <small>{t("wb.runExcludesHint")}</small>
          </label>
          <fieldset className="wb-field wb-execution">
            <legend>{t("wb.runExecution")}</legend>
            <label className="wb-check">
              <input
                type="radio"
                name="wb-execution"
                checked={execution === "workspace"}
                onChange={() => setExecution("workspace")}
              />
              <span>
                {t("wb.runExecutionWorkspace")}
                <small>{t("wb.runExecutionWorkspaceHint")}</small>
              </span>
            </label>
            <label className="wb-check">
              <input
                type="radio"
                name="wb-execution"
                checked={execution === "isolated"}
                onChange={() => {
                  setExecution("isolated");
                  setSnapshot(true);
                }}
              />
              <span>
                {t("wb.runExecutionIsolated")}
                <small>{t("wb.runExecutionIsolatedHint")}</small>
              </span>
            </label>
          </fieldset>
          {execution === "isolated" && (
            <label className="wb-field">
              <span>{t("wb.runLinks")}</span>
              <textarea
                rows={2}
                value={links}
                spellCheck={false}
                placeholder="datasets/kitti"
                onChange={(event) => setLinks(event.target.value)}
              />
              <small>{t("wb.runLinksHint")}</small>
            </label>
          )}
          {unsynced.length > 0 && (
            <div className="wb-banner is-warning" role="alert">
              <div>
                <strong>
                  {t("wb.runUnsynced", { count: String(unsynced.length) })}
                </strong>
                <span>
                  {unsynced.slice(0, 5).join(" · ")}
                  {unsynced.length > 5 ? " …" : ""}
                </span>
                <span>{t("wb.runUnsyncedHint")}</span>
              </div>
              <label className="wb-check">
                <input
                  type="checkbox"
                  checked={allowUnsynced}
                  onChange={(event) => setAllowUnsynced(event.target.checked)}
                />
                <span>{t("wb.runAllowUnsynced")}</span>
              </label>
            </div>
          )}
          {prefill?.resumedFrom && (
            <p className="wb-dialog-note">
              {t("wb.resumeHint", { id: prefill.resumedFrom.slice(0, 8) })}
            </p>
          )}
          {probe && !probe.tmux && <p className="wb-dialog-note">{t("wb.tmuxMissing")}</p>}
          {probe?.scheduler && (
            <p className="wb-dialog-note">{t("wb.schedulerDetected", { name: probe.scheduler })}</p>
          )}
        </div>
        {error && <p className="wb-dialog-error" role="alert">{error}</p>}
        <div className="wb-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn is-primary" disabled={busy}>
            {busy ? t("wb.loading") : t("wb.startRun")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
