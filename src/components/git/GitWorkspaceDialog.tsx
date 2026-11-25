import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { openSessionGit } from "../../actions";
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
import { gitDraftKey, openGitWorkspace, pickGitFolder, type GitSource } from "../../gitWorkspace";
import { IS_MAC, IS_WINDOWS } from "../../platform";
import { tabTitle, useActiveTab, useStore } from "../../store";
import { useStableCallback } from "../../useStableCallback";
import { useT } from "../../useT";
import { Icon, type IconName } from "../icons";
import { ModalDialog } from "../ModalDialog";
import { LOCAL_SOURCE, lastPaths } from "../panels/filerDirectoryCache";
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

/** Compares two folders on the same host, where the case and separator differ by platform. */
const folderKey = (path: string, local: boolean): string => {
  const normalized = local && IS_WINDOWS ? path.replace(/\\/g, "/").toLowerCase() : path;
  return normalized.replace(/\/+$/, "");
};

/** One folder the source menu can switch to, and the action that switches it. */
interface FolderChoice {
  key: string;
  label: string;
  /** Where the choice points: a folder, session or terminal, shown after the label. */
  detail?: string;
  icon: IconName;
  run: () => void;
}

/**
 * The folder menu hanging off the dialog's folder button. It lists only the
 * folders the current source can reach, keeps itself inside the dialog, and
 * gives Escape back to the button that opened it. The server path field is
 * inline: the caller validates the typed directory before the source switches,
 * and a rejection reports through the dialog's own notice instead of closing.
 */
function GitFolderMenu({
  id,
  trigger,
  choices,
  local,
  server,
  onClose,
}: {
  id: string;
  trigger: RefObject<HTMLButtonElement | null>;
  choices: FolderChoice[];
  local: FolderChoice;
  server: { submit: (directory: string) => Promise<boolean> } | null;
  onClose: (returnFocus: boolean) => void;
}) {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typingPath, setTypingPath] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const pathId = `${id}-path`;

  // Opening (or coming back from the path field) hands the keyboard to the
  // first choice; the field takes it when it appears.
  useEffect(() => {
    const target = typingPath
      ? input.current
      : menu.current?.querySelector<HTMLElement>("[data-folder-item]");
    target?.focus({ preventScroll: true });
  }, [typingPath]);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [close, trigger]);

  const submit = async () => {
    const directory = path.trim();
    if (!server || !directory || busy) return;
    setBusy(true);
    try {
      if (await server.submit(directory)) close(false);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      // The menu is the topmost surface: cancel it before the dialog's own
      // Escape can close the whole workspace.
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      // The path field's own controls keep the keyboard while it is open; a
      // tab out of the menu closes it and lets focus move on.
      if (!typingPath) close(false);
      return;
    }
    if (typingPath || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[data-folder-item]") ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };

  const entry = (choice: FolderChoice, keepOpen = false) => (
    <button
      key={choice.key}
      type="button"
      role="menuitem"
      tabIndex={-1}
      data-folder-item=""
      className="menu-entry"
      title={choice.detail}
      onClick={() => {
        if (!keepOpen) close(false);
        choice.run();
      }}
    >
      <span className="menu-icon" aria-hidden="true">
        <Icon name={choice.icon} />
      </span>
      <span className="menu-entry-label">{choice.label}</span>
      {choice.detail && (
        <span className="git-folder-detail" aria-hidden="true">
          {choice.detail}
        </span>
      )}
    </button>
  );

  return (
    <div
      id={id}
      ref={menu}
      className="menu-dropdown git-folder-menu"
      role={typingPath ? "group" : "menu"}
      aria-label={t("git.folder.menu")}
      onKeyDown={onKeyDown}
    >
      {typingPath ? (
        <form
          className="git-folder-server"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={pathId}>{t("git.folder.serverPrompt")}</label>
          <input
            ref={input}
            id={pathId}
            className="git-branch-input"
            value={path}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${pathId}-hint`}
            onChange={(event) => setPath(event.target.value)}
          />
          <p className="git-folder-hint" id={`${pathId}-hint`}>
            {t("git.folder.serverHint")}
          </p>
          <div className="git-folder-server-actions">
            <button
              type="button"
              className="git-text-button"
              disabled={busy}
              onClick={() => {
                setPath("");
                setTypingPath(false);
              }}
            >
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn" disabled={busy || !path.trim()}>
              {busy ? t("common.loading") : t("git.folder.serverOpen")}
            </button>
          </div>
        </form>
      ) : (
        <>
          {choices.map((choice) => entry(choice))}
          {server &&
            entry(
              {
                key: "server",
                label: t("git.folder.server"),
                icon: "server",
                run: () => setTypingPath(true),
              },
              true,
            )}
          {entry(local)}
        </>
      )}
    </div>
  );
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
  const headerFolderButton = useRef<HTMLButtonElement>(null);
  const welcomeFolderButton = useRef<HTMLButtonElement>(null);
  const [folderMenu, setFolderMenu] = useState<"header" | "welcome" | null>(null);
  const folderMenuId = `${useId()}-menu`;
  const activeTab = useActiveTab();
  const sessionTab = useStore((state) =>
    source.sessionId ? state.tabs.find((tab) => tab.info.id === source.sessionId) : undefined,
  );
  const sourceLabel = source.label ?? (sessionTab ? tabTitle(sessionTab) : null);
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

  function closeFolderMenu(returnFocus = false) {
    const where = folderMenu;
    setFolderMenu(null);
    if (returnFocus)
      (where === "welcome" ? welcomeFolderButton : headerFolderButton).current?.focus();
  }

  function toggleFolderMenu(where: "header" | "welcome") {
    setActionError(null);
    setFolderMenu((current) => (current === where ? null : where));
  }

  function folderMenuKey(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    where: "header" | "welcome",
  ) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setActionError(null);
    setFolderMenu(where);
  }

  /** Validates the typed server folder with the same git_status read the dialog uses. */
  async function openServerFolder(directory: string): Promise<boolean> {
    if (!source.sessionId) return false;
    setActionError(null);
    try {
      const next = await commands.gitStatus({ sessionId: source.sessionId, directory });
      if (!next) {
        setActionError(t("git.noRepository"));
        return false;
      }
      openGitWorkspace({ directory, sessionId: source.sessionId, label: sourceLabel });
      return true;
    } catch (error) {
      setActionError(errorText(error));
      return false;
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
  const localSource = source.sessionId === null;
  const sameFolder = (a: string, b: string) =>
    folderKey(a, localSource) === folderKey(b, localSource);
  const panelFolder = lastPaths.get(source.sessionId ?? LOCAL_SOURCE) ?? null;
  const terminalTab =
    activeTab &&
    (activeTab.info.kind === "local" || activeTab.info.kind === "ssh") &&
    activeTab.state === "connected"
      ? activeTab
      : undefined;
  // Only the folders this source can actually reach: a local source has no
  // server entry, and the Files panel folder is read for this session only.
  const folderChoices: FolderChoice[] = [];
  if (terminalTab) {
    folderChoices.push({
      key: "terminal",
      label: t("git.folder.terminal"),
      detail: terminalTab.info.kind === "ssh" ? tabTitle(terminalTab) : t("git.local"),
      icon: "terminal",
      run: () => void openSessionGit(terminalTab.info.id),
    });
  }
  if (
    panelFolder &&
    !sameFolder(panelFolder, location) &&
    !sameFolder(panelFolder, source.directory)
  ) {
    folderChoices.push({
      key: "filer",
      label: t("git.folder.filer"),
      detail: panelFolder,
      icon: "folder",
      run: () =>
        openGitWorkspace({
          directory: panelFolder,
          sessionId: source.sessionId,
          label: sourceLabel,
        }),
    });
  }
  const localChoice: FolderChoice = {
    key: "local",
    label: t("git.folder.local"),
    icon: "folder-opened",
    run: () => void chooseFolder(),
  };
  function folderMenuNode(where: "header" | "welcome") {
    return (
      <GitFolderMenu
        id={folderMenuId}
        trigger={where === "header" ? headerFolderButton : welcomeFolderButton}
        choices={folderChoices}
        local={localChoice}
        server={source.sessionId ? { submit: openServerFolder } : null}
        onClose={closeFolderMenu}
      />
    );
  }
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
                // The folder menu beside it carries all three attributes; without
                // expanded a reader gets no signal that a surface opened, and
                // none when it closes.
                aria-expanded={branches}
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
            <div className="git-folder-control">
              <button
                ref={headerFolderButton}
                type="button"
                className="git-icon-button"
                title={t("git.folder.menu")}
                aria-label={t("git.folder.menu")}
                aria-haspopup="menu"
                aria-expanded={folderMenu === "header"}
                aria-controls={folderMenu === "header" ? folderMenuId : undefined}
                disabled={!allowClose}
                onClick={() => toggleFolderMenu("header")}
                onKeyDown={(event) => folderMenuKey(event, "header")}
              >
                <Icon name="folder-opened" />
              </button>
              {folderMenu === "header" && folderMenuNode("header")}
            </div>
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
              <div className="git-folder-control">
                <button
                  ref={welcomeFolderButton}
                  className="btn"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={folderMenu === "welcome"}
                  aria-controls={folderMenu === "welcome" ? folderMenuId : undefined}
                  onClick={() => toggleFolderMenu("welcome")}
                  onKeyDown={(event) => folderMenuKey(event, "welcome")}
                >
                  {t("git.folder.menu")}
                </button>
                {folderMenu === "welcome" && folderMenuNode("welcome")}
              </div>
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
