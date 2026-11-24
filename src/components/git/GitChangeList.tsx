import { useState } from "react";
import type { GitAction, GitChange, GitChangeKind, GitScope, GitSelection } from "../../bindings";
import { useStore } from "../../store";
import { useT } from "../../useT";
import { FileIcon } from "../FileIcon";
import { Icon } from "../icons";

export const gitScopes = ["conflict", "working", "staged"] as const;
const PAGE_SIZE = 80;

export function selectionsOf(changes: GitChange[]) {
  const groups: Record<GitScope, GitSelection[]> = { conflict: [], working: [], staged: [] };
  for (const change of changes) {
    for (const scope of gitScopes) {
      const kind = scope === "conflict" ? (change.conflicted ? "conflict" : null) : change[scope];
      if (!kind) continue;
      groups[scope].push({
        scope,
        kind,
        path: change.path,
        originalPath: kind === "renamed" || kind === "copied" ? change.originalPath : null,
      });
    }
  }
  return groups;
}

export const selectionId = (file: GitSelection) => JSON.stringify([file.scope, file.path]);

const glyph: Record<GitChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "?",
  conflict: "!",
};

interface Props {
  groups: Record<GitScope, GitSelection[]>;
  current: GitSelection | undefined;
  filter: string;
  disabled: boolean;
  onSelect: (file: GitSelection) => void;
  onAction: (action: GitAction) => void;
}

export function GitChangeList({ groups, current, filter, disabled, onSelect, onAction }: Props) {
  const t = useT();
  const theme = useStore((state) => state.theme);
  const [limits, setLimits] = useState({
    conflict: PAGE_SIZE,
    working: PAGE_SIZE,
    staged: PAGE_SIZE,
  });
  const id = current && selectionId(current);
  const hasConflicts = groups.conflict.length > 0;
  const actionLabel = (scope: GitScope) =>
    t(
      scope === "staged"
        ? "git.unstageFile"
        : scope === "conflict"
          ? "git.stageResolution"
          : "git.stageFile",
    );
  if (gitScopes.every((scope) => groups[scope].length === 0)) {
    return <p className="git-empty">{t(filter ? "git.noMatches" : "git.clean")}</p>;
  }
  return (
    <div className="git-rows">
      {gitScopes.map((scope) => {
        const files = groups[scope];
        if (!files.length) return null;
        const kind = scope === "staged" ? "unstage" : "stage";
        const selected = files.findIndex((file) => selectionId(file) === id);
        // The selected file is part of what the reader is looking at, so the
        // page covers it rather than appending it after the rows that sort
        // earlier: appended it reads out of order, and the arrow walk stops
        // on it because no button follows.
        const limit = Math.max(limits[scope], selected + 1);
        const shown = files.slice(0, limit);
        return (
          <section
            key={scope}
            aria-label={t(`git.${scope}`)}
            className={`git-change-group is-${scope}`}
          >
            <div className="git-change-group-head">
              <h3>
                {t(`git.${scope}`)} <span>{files.length}</span>
              </h3>
              {scope !== "conflict" && !filter && !hasConflicts && (
                <button
                  className="git-text-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => onAction({ kind, path: null })}
                >
                  {t(scope === "staged" ? "git.unstageAll" : "git.stageAll")}
                </button>
              )}
            </div>
            {shown.map((file) => {
              const path = file.path;
              const slash = path.lastIndexOf("/");
              const name = path.slice(slash + 1);
              const directory = path.slice(0, slash + 1);
              const active = id === selectionId(file);
              const state = t(`git.status.${file.kind}`);
              return (
                <div key={path} className={`git-file-row${active ? " is-selected" : ""}`}>
                  <button
                    type="button"
                    className="git-file-select"
                    data-git-select
                    aria-pressed={active}
                    aria-label={`${path} · ${state} · ${t(`git.${scope}`)}`}
                    tabIndex={active ? 0 : -1}
                    title={file.originalPath ? `${file.originalPath} → ${path}` : path}
                    onClick={() => onSelect(file)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                      const buttons = Array.from(
                        event.currentTarget
                          .closest(".git-rows")
                          ?.querySelectorAll<HTMLButtonElement>("[data-git-select]") ?? [],
                      );
                      const next =
                        buttons[
                          buttons.indexOf(event.currentTarget) +
                            (event.key === "ArrowDown" ? 1 : -1)
                        ];
                      event.preventDefault();
                      next?.focus();
                      next?.click();
                    }}
                  >
                    <span className="git-file-icon">
                      <Icon name="file" />
                      <FileIcon name={name} theme={theme} isDir={false} />
                    </span>
                    <span className="git-file-name">
                      <strong>{name}</strong>
                      {directory && <small>{directory}</small>}
                    </span>
                    <span className={`git-file-kind is-${file.kind}`} title={state}>
                      {glyph[file.kind]}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="git-icon-button git-file-action"
                    tabIndex={-1}
                    disabled={disabled}
                    title={actionLabel(scope)}
                    aria-label={`${actionLabel(scope)} · ${path}`}
                    onClick={() => onAction({ kind, path })}
                  >
                    <Icon name={scope === "staged" ? "remove" : "add"} />
                  </button>
                </div>
              );
            })}
            {files.length > limit && (
              <button
                type="button"
                className="git-text-button git-show-more"
                onClick={(event) => {
                  const row = event.currentTarget.closest(".git-change-group");
                  setLimits({ ...limits, [scope]: limit + PAGE_SIZE });
                  // This button disappears once the raised limit covers every
                  // file, so the keyboard it held has to go somewhere: the
                  // selected row, which is the one the reader was paging for.
                  requestAnimationFrame(() =>
                    row
                      ?.querySelector<HTMLButtonElement>("[data-git-select][aria-pressed=true]")
                      ?.focus(),
                  );
                }}
              >
                {t("git.showMoreFiles", { count: files.length - limit })}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
