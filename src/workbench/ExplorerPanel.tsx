import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Icon } from "../components/icons";
import { useT } from "../useT";
import { buildTree, type TreeDir } from "./fileTree";
import { fuzzyFilter } from "./model";
import { useWorkbench } from "./store";
import type { Workspace } from "./types";

/** One row of the file tree, in on-screen order, for the arrow keys. */
interface TreeRow {
  id: string;
  path: string;
  kind: "dir" | "file";
  depth: number;
  expanded: boolean;
}

/** Stable id of a rendered row; a path may hold characters an id may not. */
const rowId = (path: string) => `wb-tree-${encodeURIComponent(path)}`;

export function ExplorerPanel({
  workspace,
  root,
  connected,
  onOpenFile,
  onCompare,
  onDiff,
}: {
  workspace: Workspace;
  root: string;
  connected: boolean;
  onOpenFile: (path: string) => void;
  onCompare: (path: string) => void;
  onDiff: (path: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"files" | "changes">("files");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const key = `${workspace.id}:${root}`;
  const listing = useWorkbench((state) => state.files[key]);
  const listingError = useWorkbench((state) => state.filesErrors[key]);
  const git = useWorkbench((state) => state.git[key]);
  const gitError = useWorkbench((state) => state.gitErrors[key]);
  const refreshFiles = useWorkbench((state) => state.refreshFiles);
  const refreshGit = useWorkbench((state) => state.refreshGit);

  const tree = useMemo(
    () => (listing ? buildTree(listing.files) : null),
    [listing],
  );
  const matches = useMemo(
    () =>
      filter.trim() && listing ? fuzzyFilter(filter, listing.files, 400) : null,
    [filter, listing],
  );

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /**
   * Every visible row, in on-screen order. The tree is a flat list of ids for
   * the keyboard: a filtered listing is flat by nature, and an unfiltered one
   * is walked depth-first so the order matches what is on screen.
   */
  const rows = useMemo<TreeRow[]>(() => {
    if (matches) {
      return matches.map((path) => ({
        id: rowId(path),
        path,
        kind: "file" as const,
        depth: 0,
        expanded: false,
      }));
    }
    if (!tree) return [];
    const items: TreeRow[] = [];
    const walk = (dir: TreeDir, depth: number) => {
      for (const child of dir.dirs) {
        const isOpen = expanded.has(child.path);
        items.push({
          id: rowId(child.path),
          path: child.path,
          kind: "dir",
          depth,
          expanded: isOpen,
        });
        if (isOpen) walk(child, depth + 1);
      }
      for (const file of dir.files) {
        items.push({
          id: rowId(file.path),
          path: file.path,
          kind: "file",
          depth,
          expanded: false,
        });
      }
    };
    walk(tree, 0);
    return items;
  }, [matches, tree, expanded]);

  /**
   * The row the keyboard acts on. Not a selection — the tree has none — so it
   * is announced through aria-activedescendant and the list itself is the
   * single Tab stop.
   */
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const setActive = (id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  };
  const activeIndex =
    activeId === null ? -1 : rows.findIndex((row) => row.id === activeId);
  const currentIndex =
    activeIndex >= 0 ? activeIndex : activeId !== null && rows.length > 0 ? 0 : -1;
  const currentRow = currentIndex >= 0 ? rows[currentIndex] : undefined;

  // Filtering or folding can hide the active row; the first row takes over.
  useEffect(() => {
    if (activeId !== null && activeIndex < 0) {
      const first = rows[0]?.id ?? null;
      activeIdRef.current = first;
      setActiveId(first);
    }
  }, [activeId, activeIndex, rows]);

  // Walking past the fold with the keyboard brings the row into view.
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId, rows]);

  /**
   * Points the keyboard model at a row and keeps the tree focused. A click
   * lands on the row's own button, which would take the focus off the tree
   * and silence the arrow keys; this hands it straight back.
   */
  const markActive = (id: string, target: HTMLElement) => {
    setActive(id);
    target.closest<HTMLElement>(".wb-tree")?.focus({ preventScroll: true });
  };

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys pressed on a row's own button belong to that button.
    if (event.target !== event.currentTarget) return;
    if (rows.length === 0) return;
    const row = currentRow;
    const index = currentIndex;
    const moveTo = (next: number) => {
      const target = rows[next];
      if (target) setActive(target.id);
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(index < 0 ? 0 : Math.min(rows.length - 1, index + 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        moveTo(index < 0 ? 0 : Math.max(0, index - 1));
        return;
      case "Home":
        event.preventDefault();
        moveTo(0);
        return;
      case "End":
        event.preventDefault();
        moveTo(rows.length - 1);
        return;
      case "ArrowRight": {
        event.preventDefault();
        if (!row || index < 0) return;
        if (row.kind === "dir" && !row.expanded) {
          toggle(row.path);
        } else {
          const next = rows[index + 1];
          if (next && next.depth > row.depth) moveTo(index + 1);
        }
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (!row || index < 0) return;
        if (row.kind === "dir" && row.expanded) {
          toggle(row.path);
          return;
        }
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          const candidate = rows[cursor];
          if (candidate.kind === "dir" && candidate.depth < row.depth) {
            moveTo(cursor);
            return;
          }
        }
        return;
      }
      case "Enter": {
        event.preventDefault();
        if (!row) return;
        if (row.kind === "dir") toggle(row.path);
        else onOpenFile(row.path);
        return;
      }
    }
  };

  return (
    <aside className="wb-explorer" aria-label={t("wb.files")}>
      <div className="wb-explorer-tabs">
        <button
          type="button"
          className={tab === "files" ? "is-active" : ""}
          onClick={() => setTab("files")}
        >
          {t("wb.files")}
        </button>
        <button
          type="button"
          className={tab === "changes" ? "is-active" : ""}
          onClick={() => {
            setTab("changes");
            if (connected) void refreshGit(workspace.id);
          }}
        >
          {t("wb.changes")}
          {git?.files.length ? <span className="wb-count">{git.files.length}</span> : null}
        </button>
        <button
          type="button"
          className="wb-icon-button"
          title={t("wb.refresh")}
          disabled={!connected}
          onClick={() => {
            void refreshFiles(workspace.id);
            void refreshGit(workspace.id);
          }}
        >
          <Icon name="refresh" />
        </button>
      </div>

      {!connected ? (
        /* The reason the panel is empty, and the one action that can change
           it — a bare sentence leaves the user to work out what to press. */
        <div className="wb-explorer-note">
          <p>{t("wb.connectHint")}</p>
          <button
            type="button"
            className="wb-quickopen-retry"
            onClick={() => void refreshFiles(workspace.id)}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : tab === "files" ? (
        <>
          <div className="wb-filter">
            <Icon name="search" />
            <input
              value={filter}
              placeholder={t("wb.filter")}
              aria-label={t("wb.filter")}
              onChange={(event) => setFilter(event.target.value)}
            />
            {listing && (
              <span className="wb-filter-count">{listing.files.length}</span>
            )}
          </div>
          {listingError && <p className="wb-explorer-error">{listingError}</p>}
          <div
            className="wb-tree"
            role="tree"
            aria-label={t("wb.files")}
            aria-activedescendant={activeId ?? undefined}
            tabIndex={0}
            onKeyDown={onTreeKeyDown}
          >
            {matches
              ? matches.map((path) => (
                  <FileRow
                    key={path}
                    id={rowId(path)}
                    path={path}
                    depth={0}
                    markActive={markActive}
                    onOpen={() => onOpenFile(path)}
                    onCompare={() => onCompare(path)}
                  />
                ))
              : tree &&
                renderDir(tree, 0, expanded, toggle, markActive, onOpenFile, onCompare, true)}
          </div>
          {listing?.truncated && (
            <p className="wb-explorer-note">{t("wb.filesTruncated")}</p>
          )}
        </>
      ) : (
        <>
          {gitError && <p className="wb-explorer-error">{gitError}</p>}
          {git && !git.isRepository && (
            <p className="wb-explorer-note">{t("wb.notGit")}</p>
          )}
          {git?.isRepository && (
            <div className="wb-changes">
              <div className="wb-change-head">
                <span>{git.branch || "detached"}</span>
                <code title={git.commit}>{git.commit.slice(0, 8) || "—"}</code>
                {git.diffTruncated && <span>{t("wb.diffTruncated")}</span>}
              </div>
              {git.files.length === 0 ? (
                <p className="wb-explorer-note">{t("wb.noChanges")}</p>
              ) : (
                git.files.map((file) => (
                  <div className="wb-change-row" key={`${file.status}:${file.path}`}>
                    <span className={`wb-change-status is-${file.status.trim() || "??"}`}>
                      {file.status || "??"}
                    </span>
                    <button
                      type="button"
                      className="wb-change-path"
                      title={file.path}
                      onClick={() => onDiff(file.path)}
                    >
                      {file.path}
                    </button>
                    <button
                      type="button"
                      className="wb-icon-button"
                      title={t("wb.compareTitle")}
                      onClick={() => onCompare(file.path)}
                    >
                      <Icon name="diff" />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function FileRow({
  id,
  path,
  onOpen,
  onCompare,
  depth = 0,
  markActive,
}: {
  id: string;
  path: string;
  onOpen: () => void;
  onCompare: () => void;
  depth?: number;
  markActive: (id: string, target: HTMLElement) => void;
}) {
  const t = useT();
  return (
    <div
      className="wb-file-row"
      id={id}
      style={{ paddingLeft: 8 + depth * 12 }}
      role="treeitem"
      aria-level={depth + 1}
      onMouseDown={(event) => {
        if (event.button === 0) markActive(id, event.currentTarget);
      }}
    >
      <button type="button" className="wb-file-name" title={path} onClick={onOpen}>
        <Icon name="go-to-file" />
        <span>{path.split("/").pop()}</span>
      </button>
      <button
        type="button"
        className="wb-icon-button wb-row-action"
        title={t("wb.compareTitle")}
        onClick={onCompare}
      >
        <Icon name="diff" />
      </button>
    </div>
  );
}

function renderDir(
  dir: TreeDir,
  depth: number,
  expanded: Set<string>,
  toggle: (path: string) => void,
  markActive: (id: string, target: HTMLElement) => void,
  onOpen: (path: string) => void,
  onCompare: (path: string) => void,
  root = false,
): React.ReactNode {
  return (
    <>
      {dir.dirs.map((child) => (
        <div key={`dir:${child.path}`} className="wb-dir">
          <button
            type="button"
            id={rowId(child.path)}
            className="wb-dir-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={expanded.has(child.path)}
            onClick={() => toggle(child.path)}
            onMouseDown={(event) => {
              if (event.button === 0) markActive(rowId(child.path), event.currentTarget);
            }}
          >
            <Icon name={expanded.has(child.path) ? "chevron-down" : "chevron-right"} />
            <Icon name={expanded.has(child.path) ? "folder-opened" : "folder"} />
            <span>{child.name}</span>
          </button>
          {expanded.has(child.path) &&
            renderDir(child, depth + 1, expanded, toggle, markActive, onOpen, onCompare)}
        </div>
      ))}
      {dir.files.map((file) => (
        <FileRow
          key={`file:${file.path}`}
          id={rowId(file.path)}
          path={file.path}
          depth={root ? depth : depth}
          markActive={markActive}
          onOpen={() => onOpen(file.path)}
          onCompare={() => onCompare(file.path)}
        />
      ))}
    </>
  );
}
