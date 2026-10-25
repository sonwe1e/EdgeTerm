import { useMemo, useState } from "react";
import type { DiffRow } from "../api";
import { diffChanges } from "../fileDiffLayout";
import { useT } from "../useT";
import { Icon } from "./icons";
import { FileDiffOverview } from "./FileDiffOverview";
import { useDiffViewport } from "./useDiffViewport";

export function FileDiffView({ rows }: { rows: readonly DiffRow[] }) {
  const t = useT();
  const [wrap, setWrap] = useState(true);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const changes = useMemo(() => diffChanges(rows), [rows]);
  const view = useDiffViewport(rows, wrap);
  const cursor =
    selectedRow !== null && selectedRow >= view.first && selectedRow <= view.last
      ? selectedRow
      : view.first;
  const current = changes.findIndex((change) => change.start <= cursor && change.end > cursor);
  let previous = -1;
  for (let index = 0; index < changes.length; index++) {
    if (changes[index].start < cursor) previous = index;
    else break;
  }
  const next = changes.findIndex((change) => change.start > cursor);
  const columnWidth = useMemo(
    () =>
      rows.reduce(
        (max, row) =>
          Math.max(
            max,
            Math.max(
              (row.left ?? "").replace(/\t/g, "    ").length,
              (row.right ?? "").replace(/\t/g, "    ").length,
            ) *
              16 +
              140,
          ),
        280,
      ),
    [rows],
  );
  const go = (index: number) => {
    setSelectedRow(index);
    view.jump(index);
  };
  const countLabel = !changes.length
    ? t("diff.noChanges")
    : current < 0
      ? t("diff.totalChanges", { total: changes.length })
      : t("diff.changeCount", { current: current + 1, total: changes.length });
  return (
    <div className="file-diff-view">
      <div className="file-diff-toolbar">
        <button
          type="button"
          aria-label={t("diff.previousChange")}
          disabled={previous < 0}
          onClick={() => go(changes[previous].start)}
        >
          <Icon name="arrow-up" />
          {t("diff.previousChange")}
        </button>
        <button
          type="button"
          aria-label={t("diff.nextChange")}
          disabled={next < 0}
          onClick={() => go(changes[next].start)}
        >
          <Icon name="arrow-down" />
          {t("diff.nextChange")}
        </button>
        <span className="file-diff-count" role="status">
          {countLabel}
        </span>
        <button type="button" onClick={() => go(0)}>
          {t("diff.firstLine")}
        </button>
        <button type="button" onClick={() => go(rows.length - 1)}>
          {t("diff.lastLine")}
        </button>
        <button
          type="button"
          className="file-diff-wrap"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          <Icon name="newline" />
          {t("diff.wrapLines")}
        </button>
      </div>
      <div className="file-diff-legend" aria-label={t("diff.legend")}>
        <span className="is-deleted">− {t("diff.deleted")}</span>
        <span className="is-added">+ {t("diff.added")}</span>
        <span className="is-modified">~ {t("diff.modified")}</span>
        <span>{t("diff.overviewHint")}</span>
      </div>
      <div className="file-diff-body">
        <div
          className={`file-diff-rows${wrap ? " is-wrapped" : ""}`}
          ref={view.scroller}
          tabIndex={0}
          aria-label={t("diff.linesAria")}
        >
          <div
            className="file-diff-spacer"
            style={{ height: view.total, minWidth: wrap ? undefined : columnWidth * 2 }}
          >
            {rows.slice(view.start, view.end).map((row, offset) => {
              const index = view.start + offset;
              return (
                <div
                  key={row.path}
                  className={`file-diff-row is-${row.kind}`}
                  data-diff-row={row.path}
                  data-diff-index={index}
                  style={{ top: view.offsets[index] }}
                >
                  <DiffCell line={row.leftLine} text={row.left} ending={row.leftEnding} />
                  <DiffCell line={row.rightLine} text={row.right} ending={row.rightEnding} />
                </div>
              );
            })}
          </div>
        </div>
        <FileDiffOverview
          rows={rows}
          changes={changes}
          first={view.first}
          last={view.last}
          previous={previous}
          next={next}
          onJump={go}
        />
      </div>
    </div>
  );
}

function DiffCell({
  line,
  text,
  ending,
}: {
  line: number | null;
  text: string | null;
  ending: string | null;
}) {
  return (
    <div className="file-diff-cell">
      <span className="file-diff-number">{line}</span>
      <span className="file-diff-code">{text}</span>
      <span className="file-diff-ending">{ending}</span>
    </div>
  );
}
