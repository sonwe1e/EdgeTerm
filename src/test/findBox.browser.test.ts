// The find box used to be a sibling of the workspace, pinned to the top-right
// of the whole terminal area, so in a split it stayed over the right-hand pane
// while the query went to the focused one. It now sits in the active pane's
// overlay and moves with focus.
import { createElement as h, type CSSProperties } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Workspace } from "../components/Workspace";
import { leaf } from "../layout";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const initialState = useStore.getState();

afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initialState, true);
});

const split = (activePaneId: string) =>
  useStore.setState({
    language: "en",
    tabs: [],
    activeId: null,
    layout: {
      kind: "split",
      direction: "row",
      children: [leaf("left"), leaf("right")],
      sizes: [0.5, 0.5],
    },
    panes: [
      { id: "left", activeTabId: null },
      { id: "right", activeTabId: null },
    ],
    activePaneId,
    panels: { sessions: true, filer: true, sender: true },
  });

const box = () => document.querySelector<HTMLElement>(".terminal-search")!.getBoundingClientRect();
const paneBox = (index: number) =>
  [...document.querySelectorAll<HTMLElement>(".pane")][index].getBoundingClientRect();

const fixture = () =>
  mount(
    h(
      "div",
      { className: "app", style: { width: 800, height: 500 } as CSSProperties },
      h(
        Workspace,
        { onNewSession: vi.fn(), onSaveSession: vi.fn(), onOpenProfile: vi.fn() },
        h("div", { className: "terminal-search" }, h("input", { "aria-label": "find" })),
      ),
    ),
  );

it("keeps the find box in the active pane and moves it with focus", async () => {
  split("right");
  fixture();
  await twoFrames();

  const right = paneBox(1);
  const inRight = box();
  expect(inRight.left).toBeGreaterThanOrEqual(right.left);
  expect(inRight.right).toBeLessThanOrEqual(right.right + 1);
  expect(inRight.top).toBeGreaterThanOrEqual(right.top);
  expect(inRight.bottom).toBeLessThanOrEqual(right.bottom + 1);

  // Focus the left pane: the box follows it there instead of staying right.
  useStore.setState({ activePaneId: "left" });
  await twoFrames();

  const left = paneBox(0);
  const inLeft = box();
  expect(inLeft.left).toBeGreaterThanOrEqual(left.left);
  expect(inLeft.right).toBeLessThanOrEqual(left.right + 1);
  expect(inLeft.right).toBeLessThan(right.left + 1);
});
