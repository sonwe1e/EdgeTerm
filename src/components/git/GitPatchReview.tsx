import { useMemo, useRef, useState } from "react";
import type { GitPatch } from "../../bindings";
import { useT } from "../../useT";
import { Icon } from "../icons";

interface PatchLine {
  kind: "context" | "add" | "delete" | "note";
  before: number | null;
  after: number | null;
  text: string;
}

interface Hunk {
  index: number;
  heading: string;
  lines: PatchLine[];
}

interface PatchFile {
  title: string;
  metadata: string[];
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parsePatch(text: string) {
  const files: PatchFile[] = [];
  const hunks: Hunk[] = [];
  let file: PatchFile | null = null;
  let hunk: Hunk | null = null;
  let before = 0;
  let after = 0;
  let added = 0;
  let deleted = 0;
  for (const raw of text.replace(/\n$/, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --")) {
      file = { title: line, metadata: [], hunks: [] };
      files.push(file);
      hunk = null;
    } else if (file) {
      const range = HUNK_HEADER.exec(line);
      if (range) {
        before = Number(range[1]);
        after = Number(range[2]);
        hunk = { index: hunks.length, heading: line, lines: [] };
        hunks.push(hunk);
        file.hunks.push(hunk);
      } else if (hunk) {
        const text = line.slice(1);
        switch (line[0]) {
          case "+":
            added++;
            hunk.lines.push({ kind: "add", before: null, after: after++, text });
            break;
          case "-":
            deleted++;
            hunk.lines.push({ kind: "delete", before: before++, after: null, text });
            break;
          case " ":
            hunk.lines.push({ kind: "context", before: before++, after: after++, text });
            break;
          default:
            hunk.lines.push({ kind: "note", before: null, after: null, text: line });
        }
      } else {
        if (line.startsWith("+++ b/")) file.title = line.slice(6).trimEnd();
        else if (line.startsWith("--- a/")) file.title = line.slice(6).trimEnd();
        else if (line.startsWith("rename to ")) file.title = line.slice(10);
        file.metadata.push(line);
      }
    }
  }
  return { files, hunks, added, deleted };
}

function splitRows(lines: PatchLine[]) {
  const rows: { left: PatchLine | null; right: PatchLine | null; note?: string }[] = [];
  let left: PatchLine[] = [];
  let right: PatchLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      rows.push({ left: left[i] ?? null, right: right[i] ?? null });
    }
    left = [];
    right = [];
  };
  for (const line of lines) {
    if (line.kind === "delete") {
      if (right.length) flush();
      left.push(line);
    } else if (line.kind === "add") right.push(line);
    else {
      flush();
      rows.push(
        line.kind === "note"
          ? { left: null, right: null, note: line.text }
          : { left: line, right: line },
      );
    }
  }
  flush();
  return rows;
}

function SplitCell({ line, before }: { line: PatchLine | null; before: boolean }) {
  return (
    <div className={`git-split-cell is-${line?.kind ?? "blank"}`}>
      <span className="git-line-number">{before ? line?.before : line?.after}</span>
      <code>{line?.text}</code>
    </div>
  );
}

interface Props {
  patch: GitPatch;
  split: boolean;
  onSplit: () => void;
  hunkAction?: { label: string; staged: boolean; onApply: (index: number, token: string) => void };
  disabled: boolean;
  showFileNames: boolean;
}

export function GitPatchReview({
  patch,
  split,
  onSplit,
  hunkAction,
  disabled,
  showFileNames,
}: Props) {
  const t = useT();
  const { files, hunks, added, deleted } = useMemo(() => parsePatch(patch.text), [patch.text]);
  const [cursor, setCursor] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<number, HTMLElement>());
  const current = Math.min(cursor, hunks.length - 1);
  const jump = (index: number) => {
    const hunk = sections.current.get(index);
    if (hunk && viewport.current) {
      viewport.current.scrollTop = hunk.offsetTop;
      setCursor(index);
    }
  };
  if (patch.kind !== "text") return <p className="git-empty">{t(`git.diff.${patch.kind}`)}</p>;
  const token = patch.token;
  return (
    <>
      {hunks.length > 0 && (
        <div className="git-diff-nav">
          <span className="git-diff-stat">
            <span className="is-add">+{added}</span>
            <span className="is-delete">−{deleted}</span>
          </span>
          <button
            className="git-icon-button"
            type="button"
            title={t("diff.previousChange")}
            aria-label={t("diff.previousChange")}
            disabled={current <= 0}
            onClick={() => jump(current - 1)}
          >
            <Icon name="arrow-up" />
          </button>
          <button
            className="git-icon-button"
            type="button"
            title={t("diff.nextChange")}
            aria-label={t("diff.nextChange")}
            disabled={current + 1 >= hunks.length}
            onClick={() => jump(current + 1)}
          >
            <Icon name="arrow-down" />
          </button>
          <span className="git-hunk-count" role="status">
            {t("git.hunkCount", { current: current + 1, total: hunks.length })}
          </span>
          <button className="git-split-toggle" type="button" aria-pressed={split} onClick={onSplit}>
            <Icon name="split-horizontal" />
            {t("git.split")}
          </button>
        </div>
      )}
      {split && hunks.length > 0 && (
        <div className="git-split-labels" aria-hidden="true">
          <span>{t("git.diff.before")}</span>
          <span>{t("git.diff.after")}</span>
        </div>
      )}
      <div
        ref={viewport}
        className="git-patch"
        role="region"
        aria-label={t("diff.linesAria")}
        tabIndex={0}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          jump(current + (event.key === "ArrowDown" ? 1 : -1));
        }}
      >
        {files.length === 0 && <pre className="git-metadata">{patch.text}</pre>}
        {files.map((file, fileIndex) => (
          <section key={`${fileIndex}/${file.title}`} className="git-patch-file">
            {(showFileNames || files.length > 1) && <h3 title={file.title}>{file.title}</h3>}
            {file.hunks.length === 0 && (
              <pre className="git-metadata">{file.metadata.join("\n")}</pre>
            )}
            {file.hunks.map((hunk) => (
              <section
                key={hunk.index}
                ref={(element) => {
                  if (element) sections.current.set(hunk.index, element);
                  else sections.current.delete(hunk.index);
                }}
                className="git-hunk"
              >
                <header>
                  <code>{hunk.heading}</code>
                  {token && hunkAction && (
                    <button
                      type="button"
                      className="git-hunk-action"
                      disabled={disabled}
                      aria-label={`${hunkAction.label} ${hunk.index + 1}`}
                      onClick={() => {
                        setCursor(hunk.index);
                        hunkAction.onApply(hunk.index, token);
                      }}
                    >
                      <Icon name={hunkAction.staged ? "remove" : "add"} />
                      {hunkAction.label}
                    </button>
                  )}
                </header>
                {split
                  ? splitRows(hunk.lines).map((row, index) =>
                      row.note !== undefined ? (
                        <div className="git-patch-note" key={index}>
                          {row.note}
                        </div>
                      ) : (
                        <div className="git-split-row" key={index}>
                          <SplitCell line={row.left} before />
                          <SplitCell line={row.right} before={false} />
                        </div>
                      ),
                    )
                  : hunk.lines.map((line, index) =>
                      line.kind === "note" ? (
                        <div className="git-patch-note" key={index}>
                          {line.text}
                        </div>
                      ) : (
                        <div className={`git-unified-row is-${line.kind}`} key={index}>
                          <span className="git-line-number">{line.before}</span>
                          <span className="git-line-number">{line.after}</span>
                          <span aria-hidden="true" className="git-line-sign">
                            {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}
                          </span>
                          <code>{line.text}</code>
                        </div>
                      ),
                    )}
              </section>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
