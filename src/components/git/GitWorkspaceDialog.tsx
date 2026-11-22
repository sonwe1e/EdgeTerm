import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  commands,
  type GitAction,
  type GitCommit,
  type GitDiffTarget,
  type GitPatch,
  type GitSelection,
  type GitStatus,
} from "../../bindings";
import { errorInfo, errorText } from "../../errorInfo";
import { openFileEditor, useFileEditor } from "../../fileEditor";
import { gitDraftKey, pickGitFolder, type GitSource } from "../../gitWorkspace";
import { IS_MAC, IS_WINDOWS } from "../../platform";
import { useStore } from "../../store";
import { useStableCallback } from "../../useStableCallback";
import { useT } from "../../useT";
import { Icon } from "../icons";
import { ModalDialog } from "../ModalDialog";
import { GitBranchesDialog } from "./GitBranchesDialog";
import { GitChangeList, gitScopes, selectionId, selectionsOf } from "./GitChangeList";
import { GitCommitComposer } from "./GitCommitComposer";
import { GitPatchReview } from "./GitPatchReview";
import "./gitWorkspace.styles.css";

function useRepository(source: GitSource) {
  const t = useT();
  const [status, setStatus] = useState<GitStatus | null>();
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<GitAction["kind"] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reading = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const root = useRef<string | null>(null);
  const target = useMemo(
    () => ({
      sessionId: source.sessionId,
      directory: status?.root ?? source.directory,
    }),
    [source.sessionId, source.directory, status?.root],
  );

  const refresh = useStableCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const request = ++generation.current;
    setRefreshing(true);
    setLoadError(null);
    try {
      const next = await commands.gitStatus({
        ...target,
        directory: root.current ?? target.directory,
      });
      if (request !== generation.current) return;
      if (root.current !== null && next?.root !== root.current) {
        throw new Error(t("git.repositoryMoved"));
      }
      if (next) root.current = next.root;
      setStatus(next);
      setRevision((value) => value + 1);
    } catch (error) {
      if (request === generation.current) setLoadError(errorText(error));
    } finally {
      if (request === generation.current) {
        reading.current = false;
        setRefreshing(false);
      }
    }
  });

  useEffect(() => {
    void refresh();
    const focused = () => {
      if (!writing.current) void refresh();
    };
    window.addEventListener("focus", focused);
    return () => {
      window.removeEventListener("focus", focused);
      generation.current++;
      reading.current = false;
    };
  }, [refresh]);

  async function run(action: GitAction): Promise<boolean> {
    if (!status || reading.current || writing.current || loadError) return false;
    writing.current = true;
    setMutation(action.kind);
    setActionError(null);
    setNotice(null);
    let success = false;
    try {
      await commands.gitMutate(target, action);
      success = true;
      setNotice(
        t(
          action.kind === "commit"
            ? "git.commitDone"
            : action.kind === "switch" || action.kind === "createBranch"
              ? "git.switched"
              : "git.updated",
        ),
      );
    } catch (error) {
      const info = errorInfo(error);
      setActionError(info.code === "conflict" ? t("git.stale") : info.message);
    } finally {
      await refresh();
      writing.current = false;
      setMutation(null);
    }
    return success;
  }

  return {
    status,
    target,
    revision,
    refreshing,
    loadError,
    mutation,
    actionError,
    notice,
    setActionError,
    setNotice,
    refresh,
    run,
  };
}

interface ReadState<T> {
  key: string;
  value: T | null;
  error: string | null;
}

export default function GitWorkspaceDialog({
  source,
  onClose,
}: {
  source: GitSource;
  onClose: () => void;
}) {
  const t = useT();
  const language = useStore((state) => state.language);
  const {
    status,
    target,
    revision,
    refreshing,
    loadError,
    mutation,
    actionError,
    notice,
    setActionError,
    setNotice,
    refresh,
    run,
  } = useRepository(source);
  const headingId = useId();
  const filterInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"changes" | "history">("changes");
  const [branches, setBranches] = useState(false);
  const [filter, setFilter] = useState("");
  const [historyFilter, setHistoryFilter] = useState("");
  const [picked, setPicked] = useState<GitSelection>();
  const [pickedCommit, setPickedCommit] = useState<string>();
  const [split, setSplit] = useState(false);
  const [preview, setPreview] = useState<ReadState<GitPatch> & { revision: number }>();
  const [history, setHistory] = useState<ReadState<GitCommit[]>>();
  const [editing, setEditing] = useState(false);
  const editorOpen = useFileEditor((state) => Boolean(state.target));
  const hadEditor = useRef(false);
  const disabled = !!mutation || refreshing || !!loadError || editing;
  const allowClose = !mutation && !editing;
  const groups = useMemo(() => selectionsOf(status?.changes ?? []), [status]);
  const query = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return groups;
    const matches = (file: GitSelection) =>
      file.path.toLowerCase().includes(query) ||
      Boolean(file.originalPath?.toLowerCase().includes(query));
    return {
      conflict: groups.conflict.filter(matches),
      working: groups.working.filter(matches),
      staged: groups.staged.filter(matches),
    };
  }, [groups, query]);
  const selection = useMemo(() => {
    const files = gitScopes.flatMap((scope) => filtered[scope]);
    return (
      files.find((file) => file.path === picked?.path && file.scope === picked.scope) ??
      files.find((file) => file.path === picked?.path) ??
      files[0]
    );
  }, [filtered, picked]);
  const historyHead = status?.head;
  const currentHistory = history?.key === historyHead ? history : undefined;
  const commits = useMemo(() => {
    const value = historyFilter.trim().toLowerCase();
    return (
      currentHistory?.value?.filter(
        (commit) =>
          !value ||
          [commit.subject, commit.author, commit.oid].some((part) =>
            part.toLowerCase().includes(value),
          ),
      ) ?? []
    );
  }, [currentHistory, historyFilter]);
  const commit = commits.find((item) => item.oid === pickedCommit) ?? commits[0];
  const diff = useMemo<GitDiffTarget | undefined>(() => {
    if (mode === "history") return commit ? { kind: "commit", oid: commit.oid } : undefined;
    return selection ? { kind: "file", file: selection } : undefined;
  }, [mode, commit, selection]);
  const patchId = diff?.kind === "file" ? selectionId(diff.file) : diff?.oid;
  const currentPreview = preview?.key === patchId ? preview : undefined;

  useEffect(() => {
    if (!diff || !patchId) return;
    let active = true;
    commands.gitDiff(target, diff).then(
      (value) => {
        if (active) setPreview({ key: patchId, revision, value, error: null });
      },
      (error) => {
        if (active) setPreview({ key: patchId, revision, value: null, error: errorText(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [target, diff, patchId, revision]);

  useEffect(() => {
    if (mode !== "history" || !historyHead || history?.key === historyHead) return;
    let active = true;
    commands.gitHistory(target, historyHead).then(
      (value) => {
        if (active) setHistory({ key: historyHead, value, error: null });
      },
      (error) => {
        if (active) setHistory({ key: historyHead, value: null, error: errorText(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [mode, target, historyHead, history?.key]);

  useEffect(() => {
    if (!editorOpen && hadEditor.current) void refresh();
    hadEditor.current = editorOpen;
  }, [editorOpen, refresh]);

  function refreshAll() {
    if (history?.error) setHistory(undefined);
    setNotice(null);
    setActionError(null);
    void refresh();
  }

  async function chooseFolder() {
    setActionError(null);
    try {
      await pickGitFolder(undefined, source.sessionId ? undefined : target.directory);
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  function reviewStaged() {
    setMode("changes");
    setFilter("");
    setPicked(groups.staged[0]);
    requestAnimationFrame(() =>
      list.current
        ?.querySelector<HTMLButtonElement>("[data-git-select][aria-pressed=true]")
        ?.focus(),
    );
  }

  async function edit(file: GitSelection) {
    const path = `${target.directory.replace(/\/$/, "")}/${file.path}`;
    setEditing(true);
    setActionError(null);
    try {
      if ((await openFileEditor(source.sessionId, path)) === false)
        setActionError(t("git.editFailed"));
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setEditing(false);
    }
  }

  async function copyCommit(oid: string) {
    try {
      await commands.writeClipboardText(oid);
      setNotice(t("git.copiedCommit"));
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  const location = status?.root ?? source.directory;
  const parts = (IS_WINDOWS && !source.sessionId ? location.replace(/\\/g, "/") : location)
    .split("/")
    .filter(Boolean);
  const repoName = parts[parts.length - 1] ?? location;
  const branch =
    status?.branch ??
    (status?.head ? `${t("git.detached")} · ${status.head.slice(0, 7)}` : t("git.detached"));
  const file = diff?.kind === "file" ? diff.file : undefined;
  const staged = file?.scope === "staged";
  const fileAction =
    file &&
    t(
      staged
        ? "git.unstageFile"
        : file.scope === "conflict"
          ? "git.stageResolution"
          : "git.stageFile",
    );
  const paired =
    file?.scope === "working"
      ? groups.staged.find(({ path }) => path === file.path)
      : file?.scope === "staged"
        ? groups.working.find(({ path }) => path === file.path)
        : undefined;
  const draft = status && gitDraftKey(source, status);
  const date =
    commit &&
    new Date(commit.date).toLocaleDateString(language, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  return (
    <>
      <ModalDialog
        open
        dismissable={false}
        closeOnEscape={allowClose}
        onClose={onClose}
        labelledBy={headingId}
        initialFocus=".git-close"
        contentClassName="git-workspace"
        onKeyDown={(event) => {
          if (
            event.key.toLowerCase() === "f" &&
            (IS_MAC ? event.metaKey : event.ctrlKey) &&
            filterInput.current
          ) {
            event.preventDefault();
            filterInput.current.focus();
            filterInput.current.select();
          }
        }}
      >
        <header className="git-workspace-head">
          <span className="git-workspace-icon">
            <Icon name="source-control" />
          </span>
          <div className="git-location">
            <h2 id={headingId} aria-label={`${t("git.title")} · ${repoName}`}>
              {repoName}
            </h2>
            <span className="git-location-line">
              <span title={source.label ?? t("git.local")}>{source.label ?? t("git.local")}</span>
              <code title={location}>{location}</code>
            </span>
          </div>
          {status && (
            <div className="git-branch-control">
              <button
                type="button"
                className="git-branch-button"
                title={`${t("git.branchPicker")} · ${branch}`}
                aria-haspopup="dialog"
                disabled={disabled}
                onClick={() => {
                  setActionError(null);
                  setBranches(true);
                }}
              >
                <Icon name="git-branch" />
                <span>{branch}</span>
                <Icon name="chevron-down" />
              </button>
              {status.upstream && (
                <span
                  className="git-tracking"
                  title={t("git.tracking", {
                    ahead: status.ahead,
                    behind: status.behind,
                    upstream: status.upstream,
                  })}
                >
                  ↑{status.ahead} ↓{status.behind}
                </span>
              )}
            </div>
          )}
          <div className="git-workspace-actions">
            <button
              type="button"
              className="git-icon-button"
              title={t("filer.refresh")}
              aria-label={t("filer.refresh")}
              disabled={!!mutation || refreshing}
              onClick={refreshAll}
            >
              <Icon name="refresh" />
            </button>
            <button
              type="button"
              className="git-icon-button"
              title={t("git.openFolder")}
              aria-label={t("git.openFolder")}
              disabled={!allowClose}
              onClick={() => void chooseFolder()}
            >
              <Icon name="folder-opened" />
            </button>
            <button
              type="button"
              className="git-icon-button git-close"
              title={t("common.close")}
              aria-label={t("common.close")}
              disabled={!allowClose}
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        {(loadError || actionError || notice) && (
          <div
            className={`git-notice${loadError || actionError ? " is-error" : ""}`}
            role={loadError || actionError ? "alert" : "status"}
          >
            <Icon name={loadError || actionError ? "warning" : "check"} />
            <span>{[actionError || notice, loadError].filter(Boolean).join(" · ")}</span>
          </div>
        )}
        {status ? (
          <div className="git-workspace-body">
            <aside className="git-sidebar" aria-label={t("git.title")}>
              <div className="git-sidebar-tabs" aria-label={t("git.title")} role="group">
                <button
                  type="button"
                  aria-pressed={mode === "changes"}
                  onClick={() => setMode("changes")}
                >
                  <Icon name="diff" /> {t("git.changes")} <span>{status.changes.length}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "history"}
                  onClick={() => setMode("history")}
                >
                  <Icon name="history" /> {t("git.history")}
                </button>
              </div>
              <label className="git-filter">
                <Icon name="search" />
                <input
                  ref={filterInput}
                  type="search"
                  aria-label={t(mode === "changes" ? "git.filter" : "git.filterCommits")}
                  placeholder={t(mode === "changes" ? "git.filter" : "git.filterCommits")}
                  value={mode === "changes" ? filter : historyFilter}
                  onChange={(event) =>
                    (mode === "changes" ? setFilter : setHistoryFilter)(event.target.value)
                  }
                />
              </label>
              <div className="git-sidebar-scroll" ref={list}>
                {mode === "changes" ? (
                  <GitChangeList
                    groups={filtered}
                    current={selection}
                    disabled={disabled}
                    filter={query}
                    onSelect={setPicked}
                    onAction={(action) => void run(action)}
                  />
                ) : (
                  <div className="git-history-list">
                    {currentHistory?.error && (
                      <p className="git-empty" role="alert">
                        {currentHistory.error}
                      </p>
                    )}
                    {!currentHistory?.error && !commits.length && (
                      <p className="git-empty">
                        {t(
                          !historyHead
                            ? "git.noHistory"
                            : currentHistory
                              ? "git.noCommitsMatch"
                              : "common.loading",
                        )}
                      </p>
                    )}
                    {commits.map((item) => (
                      <button
                        type="button"
                        className="git-history-row"
                        key={item.oid}
                        aria-pressed={item.oid === commit?.oid}
                        title={item.subject}
                        onClick={() => setPickedCommit(item.oid)}
                      >
                        <Icon name="git-commit" />
                        <span>
                          <strong>{item.subject || item.shortOid}</strong>
                          <small>
                            <code>{item.shortOid}</code> · {item.author}
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </aside>
            <section
              className="git-review"
              aria-busy={Boolean(patchId && currentPreview?.revision !== revision)}
            >
              {file && (
                <div className="git-review-head">
                  <div className="git-review-title">
                    <h3 title={file.path}>{file.path}</h3>
                    <span title={file.originalPath ?? undefined}>
                      {t(`git.${file.scope}`)} · {t(`git.status.${file.kind}`)}
                      {file.originalPath && ` · ${file.originalPath}`}
                    </span>
                  </div>
                  <div className="git-review-actions">
                    {paired && (
                      <button
                        type="button"
                        className="git-text-button"
                        onClick={() => {
                          if (!filtered[paired.scope].includes(paired)) setFilter("");
                          setPicked(paired);
                        }}
                      >
                        {t(`git.${paired.scope}`)} <Icon name="arrow-swap" />
                      </button>
                    )}
                    {file.kind !== "deleted" && !file.path.endsWith("/") && (
                      <button
                        type="button"
                        className="git-icon-button"
                        title={t("git.editWorking")}
                        aria-label={t("git.editWorking")}
                        disabled={disabled}
                        onClick={() => void edit(file)}
                      >
                        <Icon name="edit" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn git-file-command"
                      disabled={disabled}
                      onClick={() =>
                        void run({ kind: staged ? "unstage" : "stage", path: file.path })
                      }
                    >
                      <Icon name={staged ? "remove" : "add"} /> {fileAction}
                    </button>
                  </div>
                </div>
              )}
              {mode === "history" && commit && (
                <div className="git-review-head">
                  <div className="git-review-title">
                    <h3 title={commit.subject}>{commit.subject || commit.shortOid}</h3>
                    <span>
                      {commit.author} · {date} · <code>{commit.shortOid}</code>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="git-icon-button"
                    title={t("git.copyCommit")}
                    aria-label={t("git.copyCommit")}
                    onClick={() => void copyCommit(commit.oid)}
                  >
                    <Icon name="copy" />
                  </button>
                </div>
              )}
              {currentPreview?.error && (
                <p className="git-empty" role="alert">
                  {currentPreview.error}
                </p>
              )}
              {currentPreview?.value ? (
                <GitPatchReview
                  key={patchId}
                  patch={currentPreview.value}
                  split={split}
                  onSplit={() => setSplit(!split)}
                  disabled={disabled || currentPreview.revision !== revision}
                  showFileNames={mode === "history"}
                  hunkAction={
                    file && file.scope !== "conflict"
                      ? {
                          label: t(staged ? "git.unstageHunk" : "git.stageHunk"),
                          staged,
                          onApply: (index, token) =>
                            void run({
                              kind: "hunk",
                              index,
                              token,
                              path: file.path,
                              scope: file.scope,
                            }),
                        }
                      : undefined
                  }
                />
              ) : (
                !currentPreview?.error && (
                  <p className="git-empty git-review-empty">
                    <Icon name={diff ? "diff" : mode === "history" ? "history" : "check"} />
                    {t(
                      diff
                        ? "common.loading"
                        : mode === "history"
                          ? historyHead
                            ? "git.history"
                            : "git.noHistory"
                          : query
                            ? "git.noMatches"
                            : "git.clean",
                    )}
                  </p>
                )
              )}
            </section>
          </div>
        ) : (
          <div className="git-welcome">
            <Icon name="source-control" />
            {refreshing && <p role="status">{t("common.loading")}</p>}
            {!refreshing && !loadError && <p>{t("git.noRepository")}</p>}
            {!refreshing && (
              <button className="btn" type="button" onClick={() => void chooseFolder()}>
                {t("git.openFolder")}
              </button>
            )}
          </div>
        )}
        {status && draft && (
          <GitCommitComposer
            key={draft}
            draft={draft}
            staged={groups.staged.length}
            working={groups.working.length}
            conflicts={groups.conflict.length}
            disabled={disabled}
            committing={mutation === "commit"}
            onReview={reviewStaged}
            onCommit={(message) => run({ kind: "commit", token: status.commitToken, message })}
          />
        )}
      </ModalDialog>
      {branches && status && (
        <GitBranchesDialog
          target={target}
          status={status}
          busy={disabled}
          error={actionError || loadError}
          onAction={run}
          onClose={() => setBranches(false)}
        />
      )}
    </>
  );
}
