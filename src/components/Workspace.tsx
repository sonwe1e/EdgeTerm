import { useMemo, useRef, type CSSProperties } from "react";

import appIcon from "../../src-tauri/icons/128x128@2x.png";
import { layoutRects, type Rect, type SplitterRect } from "../layout";
import { chordLabel } from "../shortcuts";
import { useStore } from "../store";
import { useT } from "../useT";
import { useWorkbench } from "../workbench/store";
import { Splitter } from "./Splitter";
import { TabStrip } from "./TabStrip";
import { SessionPane } from "./TerminalPane";

interface Props {
  onNewSession: () => void;
}

/** A pane keeps at least this much room, in pixels, when a splitter is dragged. */
const MIN_PANE_PX = 120;

const percent = (fraction: number): string => `${fraction * 100}%`;

/** A pane's box: its strip on top, its sessions below. */
const paneStyle = (rect: Rect): CSSProperties => ({
  left: percent(rect.x),
  top: percent(rect.y),
  width: percent(rect.w),
  height: percent(rect.h),
});

/**
 * A session's box: the pane's, minus the strip. One style object per rect, so
 * a session pane that is memoized sees the same prop until the layout moves.
 */
const slotStyles = new WeakMap<Rect, CSSProperties>();
const slotStyle = (rect: Rect): CSSProperties => {
  let style = slotStyles.get(rect);
  if (!style) {
    style = {
      left: percent(rect.x),
      top: `calc(${percent(rect.y)} + var(--tabstrip-height))`,
      width: percent(rect.w),
      height: `calc(${percent(rect.h)} - var(--tabstrip-height))`,
    };
    slotStyles.set(rect, style);
  }
  return style;
};

/** The line a splitter sits on; its thickness comes from the stylesheet. */
const splitterStyle = (splitter: SplitterRect): CSSProperties =>
  splitter.direction === "row"
    ? {
        left: percent(splitter.rect.x),
        top: percent(splitter.rect.y),
        height: percent(splitter.rect.h),
      }
    : {
        left: percent(splitter.rect.x),
        top: percent(splitter.rect.y),
        width: percent(splitter.rect.w),
      };

/**
 * The terminal area: the panes the layout tree divides it into, each with
 * its tab strip, and every open session placed over the pane that holds it.
 *
 * Sessions are not rendered inside their pane's element. They are one flat
 * list keyed by session, positioned over the pane's rectangle, so moving a
 * tab to another pane changes a style and never remounts the session — an
 * xterm keeps its scrollback and a file pane keeps the directories it is in
 * and the transfer it is running. Everything is placed in fractions of this
 * element (the tree knows no pixels), and the splitters overlay the
 * boundaries, so a pane's box is exactly its share.
 */
export function Workspace({ onNewSession }: Props) {
  const t = useT();
  const layout = useStore((s) => s.layout);
  const panes = useStore((s) => s.panes);
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const activePaneId = useStore((s) => s.activePaneId);
  const dropTarget = useStore((s) => s.dropTarget);
  const resizeLayout = useStore((s) => s.resizeLayout);
  const newSessionKey = useStore((s) => chordLabel(s.shortcuts.newSession));
  // The three capabilities the hero empty state used to leave to the View menu
  // (PD-05). Each panel entry reads its real binding, and the workbench has no
  // bound command, so its entry shows no chord rather than an invented one.
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const setWorkbenchView = useWorkbench((s) => s.setView);
  const filerKey = useStore((s) => chordLabel(s.shortcuts.panelFiler));
  const senderKey = useStore((s) => chordLabel(s.shortcuts.panelSender));
  // The hint wraps the chord in a <kbd>; the catalogs put {key} where it goes.
  // The built-in local shell is named from the same catalog entry as the row,
  // so the hint and the thing it points at cannot disagree.
  const hint = t("empty.hint").replace("{localShell}", t("panel.localShell"));
  const hintNoKey = t("empty.hintNoKey").replace("{localShell}", t("panel.localShell"));
  const [hintBeforeKey, hintAfterKey = ""] = hint.split("{key}");
  const ref = useRef<HTMLDivElement>(null);
  const rects = useMemo(() => layoutRects(layout), [layout]);

  // One line per capability, under the hero button. The panel entries name the
  // action in force (open / hide) so the label stays true after a toggle, the
  // way the View menu's own checkboxes do. Each entry carries a stable id:
  // keying the rows on the label would remount a button the moment its label
  // flips, dropping the keyboard focus that just activated it.
  const capabilityEntries = [
    {
      id: "filer",
      label: panels.filer ? t("empty.hideFiler") : t("empty.openFiler"),
      hint: t("empty.openFilerHint"),
      chord: filerKey,
      action: () => togglePanel("filer"),
    },
    {
      id: "sender",
      label: panels.sender ? t("empty.hideSender") : t("empty.openSender"),
      hint: t("empty.openSenderHint"),
      chord: senderKey,
      action: () => togglePanel("sender"),
    },
    {
      id: "workbench",
      label: t("empty.openWorkbench"),
      hint: t("empty.openWorkbenchHint"),
      chord: "",
      action: () => setWorkbenchView("workbench"),
    },
  ];

  // A splitter drag arrives in pixels; the tree takes fractions of the split
  // the splitter belongs to.
  const resize = (splitter: SplitterRect, deltaPx: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const size = (splitter.direction === "row" ? box.width : box.height) * splitter.extent;
    if (size <= 0) return;
    resizeLayout(splitter.path, splitter.index, deltaPx / size, MIN_PANE_PX / size);
  };

  return (
    <div className="workspace" ref={ref}>
      {panes.map((pane) => {
        const rect = rects.panes.get(pane.id);
        if (!rect) return null;
        const zone =
          dropTarget?.paneId === pane.id && dropTarget.zone !== "strip" ? dropTarget.zone : null;
        return (
          <div
            key={pane.id}
            className={`pane${pane.id === activePaneId ? " is-focused" : ""}`}
            style={paneStyle(rect)}
          >
            <TabStrip paneId={pane.id} />
            <div className="pane-stack" data-pane-id={pane.id}>
              {tabs.length === 0 && (
                <div className="term-empty">
                  <img className="term-empty-icon" src={appIcon} alt="" draggable={false} />
                  <h1>EdgeTerm</h1>
                  <p className="term-empty-hint">
                    {newSessionKey ? (
                      <>
                        {hintBeforeKey}
                        <kbd>{newSessionKey}</kbd>
                        {hintAfterKey}
                      </>
                    ) : (
                      hintNoKey
                    )}
                  </p>
                  <button className="btn is-primary" onClick={onNewSession}>
                    {t("empty.newSession")}
                  </button>
                  <div className="term-empty-entries">
                    {capabilityEntries.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="term-empty-entry"
                        // The visible text is label + chord + hint; the
                        // accessible name keeps the label and its chord, the
                        // way the bar's own buttons name themselves.
                        aria-label={entry.chord ? `${entry.label} (${entry.chord})` : entry.label}
                        onClick={entry.action}
                      >
                        <span className="term-empty-entry-label">
                          {entry.label}
                          {entry.chord && <kbd>{entry.chord}</kbd>}
                        </span>
                        <span className="term-empty-entry-hint">{entry.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {zone && <div className={`pane-drop is-${zone}`} aria-hidden="true" />}
            </div>
          </div>
        );
      })}

      {tabs.map((tab) => {
        const rect = rects.panes.get(tab.paneId);
        const pane = panes.find((item) => item.id === tab.paneId);
        if (!rect || !pane) return null;
        return (
          <SessionPane
            key={tab.info.id}
            tab={tab}
            visible={pane.activeTabId === tab.info.id}
            focused={activeId === tab.info.id}
            style={slotStyle(rect)}
          />
        );
      })}

      {rects.splitters.map((splitter) => (
        <div
          key={`${splitter.path.join(".")}:${splitter.index}`}
          className={`pane-splitter is-${splitter.direction}`}
          style={splitterStyle(splitter)}
        >
          <Splitter
            orientation={splitter.direction === "row" ? "vertical" : "horizontal"}
            onResize={(delta) => resize(splitter, delta)}
          />
        </div>
      ))}
    </div>
  );
}
