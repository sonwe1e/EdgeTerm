import { useState } from "react";
import { ModalDialog } from "../components/ModalDialog";
import { errorText } from "../errorInfo";
import { useT } from "../useT";
import type { Experiment, ExperimentKind, Workspace } from "./types";

export function ExperimentDialog({
  workspace,
  experiments,
  experiment,
  onClose,
  onSubmit,
}: {
  workspace: Workspace;
  experiments: Experiment[];
  experiment: Experiment | null;
  onClose: () => void;
  onSubmit: (experiment: Experiment) => Promise<void>;
}) {
  const t = useT();
  const baselines = experiments.filter(
    (item) => item.kind === "baseline" && item.id !== experiment?.id,
  );
  const [name, setName] = useState(experiment?.name ?? "");
  const [kind, setKind] = useState<ExperimentKind>(
    experiment?.kind ?? (baselines.length ? "variant" : "baseline"),
  );
  const [baselineId, setBaselineId] = useState(experiment?.baselineId ?? baselines[0]?.id ?? "");
  const [root, setRoot] = useState(experiment?.root ?? "");
  const [branch, setBranch] = useState(experiment?.branch ?? "");
  const [notes, setNotes] = useState(experiment?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      setError(t("wb.nameRequired"));
      return;
    }
    if (kind === "variant" && !baselineId) {
      setError(t("wb.baselineRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        id: experiment?.id ?? "",
        workspaceId: workspace.id,
        name: name.trim(),
        kind,
        baselineId: kind === "variant" ? baselineId : null,
        root: root.trim() || null,
        branch: branch.trim() || null,
        notes,
        createdAt: experiment?.createdAt ?? 0,
        updatedAt: experiment?.updatedAt ?? 0,
      });
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open
      onClose={onClose}
      ariaLabel={t("wb.newExperiment")}
      contentClassName="wb-form-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="wb-dialog-header">
          <strong>{experiment ? t("wb.editExperiment") : t("wb.newExperiment")}</strong>
          <button
            type="button"
            className="wb-icon-button"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="wb-form">
          <label className="wb-field">
            <span>{t("wb.experimentName")}</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="ablation A"
            />
          </label>
          <label className="wb-field">
            <span>{t("wb.experimentKind")}</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as ExperimentKind)}
            >
              <option
                value="baseline"
                disabled={baselines.length > 0 && experiment?.kind !== "baseline"}
              >
                {t("wb.baseline")}
              </option>
              <option
                value="variant"
                disabled={baselines.length === 0 && experiment?.kind !== "variant"}
              >
                {t("wb.variant")}
              </option>
            </select>
          </label>
          {kind === "variant" && (
            <label className="wb-field">
              <span>{t("wb.against")}</span>
              <select value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
                <option value="">—</option>
                {baselines.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="wb-field">
            <span>{t("wb.rootOverride")}</span>
            <input
              value={root}
              spellCheck={false}
              placeholder={workspace.root}
              onChange={(event) => setRoot(event.target.value)}
            />
            <small>{t("wb.rootOverrideHint")}</small>
          </label>
          <label className="wb-field">
            <span>{t("wb.branch")}</span>
            <input
              value={branch}
              spellCheck={false}
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
          <label className="wb-field">
            <span>{t("wb.notes")}</span>
            <textarea
              rows={3}
              value={notes}
              placeholder={t("wb.noExperimentsHint")}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
        </div>
        {error && (
          <p className="wb-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="wb-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn is-primary" disabled={busy}>
            {t("common.save")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
