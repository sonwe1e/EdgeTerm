import { useState } from "react";
import { readGitDraft, writeGitDraft } from "../../gitWorkspace";
import { IS_MAC } from "../../platform";
import { useT } from "../../useT";
import { Icon } from "../icons";

interface Props {
  draft: string;
  staged: number;
  working: number;
  conflicts: number;
  disabled: boolean;
  committing: boolean;
  onReview: () => void;
  onCommit: (message: string) => Promise<boolean>;
}

export function GitCommitComposer({
  draft,
  staged,
  working,
  conflicts,
  disabled,
  committing,
  onReview,
  onCommit,
}: Props) {
  const t = useT();
  const [message, setMessage] = useState(() => readGitDraft(draft));
  const canCommit = !disabled && !conflicts && staged > 0 && Boolean(message.trim());
  const shortcut = IS_MAC ? "⌘↵" : "Ctrl+Enter";
  async function commit() {
    if (canCommit && (await onCommit(message))) {
      writeGitDraft(draft, "");
      setMessage("");
    }
  }
  return (
    <div className="git-composer">
      <textarea
        aria-label={t("git.commitMessage")}
        placeholder={t("git.commitMessage")}
        value={message}
        rows={2}
        maxLength={8000}
        disabled={committing}
        onChange={(event) => {
          setMessage(event.target.value);
          writeGitDraft(draft, event.target.value);
        }}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.key !== "Enter" ||
            !(IS_MAC ? event.metaKey : event.ctrlKey)
          )
            return;
          event.preventDefault();
          void commit();
        }}
      />
      <div className="git-commit-summary">
        <span>
          {conflicts
            ? t("git.conflictBlock", { count: conflicts })
            : t("git.commitSummary", { staged, working })}
        </span>
        {staged > 0 && (
          <button type="button" className="git-text-button" onClick={onReview}>
            {t("git.reviewStaged")}
          </button>
        )}
      </div>
      <button
        type="button"
        className={`btn is-primary${committing ? " is-loading" : ""}`}
        disabled={!canCommit}
        title={t("git.commitAction", { shortcut })}
        onClick={() => void commit()}
      >
        {!committing && <Icon name="git-commit" />}
        {t("git.commit")}
      </button>
    </div>
  );
}
