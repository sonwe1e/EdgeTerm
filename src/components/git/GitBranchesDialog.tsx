import { useEffect, useId, useState } from "react";
import { commands, type GitAction, type GitStatus, type GitTarget } from "../../bindings";
import { errorText } from "../../errorInfo";
import { useT } from "../../useT";
import { Icon } from "../icons";
import { ModalDialog } from "../ModalDialog";

interface Props {
  target: GitTarget;
  status: GitStatus;
  busy: boolean;
  error: string | null;
  onAction: (action: GitAction) => Promise<boolean>;
  onClose: () => void;
}

export function GitBranchesDialog({ target, status, busy, error, onAction, onClose }: Props) {
  const t = useT();
  const label = useId();
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    commands.gitBranches(target).then(
      (value) => {
        if (active) setBranches(value);
      },
      (cause) => {
        if (active) setLoadError(errorText(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [target]);
  const name = query.trim();
  const matches = branches?.filter((branch) => branch.toLowerCase().includes(name.toLowerCase()));
  const switchTo = selected ?? branches?.find((branch) => branch === name);
  const visible = matches?.slice(0, 100) ?? [];
  const canCreate = Boolean(branches && name && !branches.includes(name) && name !== status.branch);
  async function apply(kind: "switch" | "createBranch", branch: string) {
    if (await onAction({ kind, branch, token: status.commitToken })) onClose();
  }
  return (
    <ModalDialog
      open
      title={t("git.branchPicker")}
      labelledBy={label}
      contentClassName="git-branch-dialog"
      initialFocus=".git-branch-input"
      closeOnEscape={!busy}
      dismissable={false}
      onClose={onClose}
    >
      <div className="git-branch-body">
        <input
          className="git-branch-input"
          value={query}
          disabled={busy}
          aria-label={t("git.branchFilter")}
          placeholder={t("git.branchFilter")}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(null);
          }}
        />
        <div className="git-branch-list">
          {visible.map((branch) => (
            <button
              key={branch}
              type="button"
              className="git-branch-row"
              aria-pressed={branch === switchTo}
              aria-current={branch === status.branch ? "true" : undefined}
              disabled={busy}
              onClick={() => setSelected(branch)}
            >
              <Icon name={branch === status.branch ? "check" : "git-branch"} />
              <span>{branch}</span>
            </button>
          ))}
          {!loadError && !visible.length && (
            <p className="git-empty">{t(branches ? "git.noBranches" : "common.loading")}</p>
          )}
        </div>
        {(loadError || error) && (
          <p className="dialog-error" role="alert">
            {loadError || error}
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <button className="btn" type="button" onClick={onClose} disabled={busy}>
          {t("common.close")}
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy || !canCreate}
          onClick={() => void apply("createBranch", name)}
        >
          {t("git.createBranch")}
        </button>
        <button
          className="btn is-primary"
          type="button"
          disabled={busy || !switchTo || switchTo === status.branch}
          onClick={() => {
            if (switchTo) void apply("switch", switchTo);
          }}
        >
          {t("git.switchBranch")}
        </button>
      </div>
    </ModalDialog>
  );
}
