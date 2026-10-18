import { useMemo, useState } from "react";
import { Icon } from "../components/icons";
import { useT } from "../useT";
import { buildTree, type TreeDir } from "./fileTree";
import { fuzzyFilter } from "./model";
import { useWorkbench } from "./store";
import type { Workspace } from "./types";

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

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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
        <p className="wb-explorer-note">{t("wb.connectHint")}</p>
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
          <div className="wb-tree" role="tree">
            {matches
              ? matches.map((path) => (
                  <FileRow
                    key={path}
                    path={path}
                    onOpen={() => onOpenFile(path)}
                    onCompare={() => onCompare(path)}
                  />
                ))
              : tree &&
                renderDir(tree, 0, expanded, toggle, onOpenFile, onCompare, true)}
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
  path,
  onOpen,
  onCompare,
  depth = 0,
}: {
  path: string;
  onOpen: () => void;
  onCompare: () => void;
  depth?: number;
}) {
  const t = useT();
  return (
    <div className="wb-file-row" style={{ paddingLeft: 8 + depth * 12 }} role="treeitem">
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
            className="wb-dir-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggle(child.path)}
            aria-expanded={expanded.has(child.path)}
          >
            <Icon name={expanded.has(child.path) ? "chevron-down" : "chevron-right"} />
            <Icon name={expanded.has(child.path) ? "folder-opened" : "folder"} />
            <span>{child.name}</span>
          </button>
          {expanded.has(child.path) &&
            renderDir(child, depth + 1, expanded, toggle, onOpen, onCompare)}
        </div>
      ))}
      {dir.files.map((file) => (
        <FileRow
          key={`file:${file.path}`}
          path={file.path}
          depth={root ? depth : depth}
          onOpen={() => onOpen(file.path)}
          onCompare={() => onCompare(file.path)}
        />
      ))}
    </>
  );
}

