import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { TabStrip } from "../components/TabStrip";
import { useStore, type Tab } from "../store";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
import "../styles.css";

vi.mock("../components/TerminalPane", () => ({ useAccelerator: () => "" }));
const initial = useStore.getState();
beforeEach(async () => {
  await page.viewport(1100, 720);
});
afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial);
});

function fixture() {
  const paneId = initial.activePaneId;
  const tabs: Tab[] = ["first", "second"].map((id, index) => ({
    info: {
      id,
      name: id,
      kind: "local",
      protocol: "local",
      profileId: null,
      address: "fixture",
      color: null,
      supportsRemoteFiles: false,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id, name: id, kind: "local" },
    number: index + 1,
    ordinal: index,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId,
  }));
  useStore.setState({
    ...initial,
    tabs,
    activeId: "first",
    panes: [{ id: paneId, activeTabId: "first" }],
  });
  return mount(
    h(
      "div",
      {
        className: "workspace pane-stack",
        "data-pane-id": paneId,
        style: { width: 600, height: 400 },
      },
      h(TabStrip, { paneId }),
    ),
  );
}

async function start() {
  const from = pagePoint(document.querySelector(".tab")!);
  const to = pagePoint(document.querySelector(".pane-stack")!, 0.95, 0.4);
  await mouse.press(from.x, from.y);
  await mouse.moveTo(to.x, to.y);
  expect(useStore.getState().dropTarget?.zone).toBe("right");
  return to;
}

it("Escape cancels a pending split and the later release cannot commit it", async () => {
  fixture();
  const to = await start();
  await userEvent.keyboard("{Escape}");
  expect(useStore.getState().draggingTabId).toBeNull();
  expect(document.querySelector(".tab-drag-ghost")).toBeNull();
  await mouse.release(to.x, to.y);
  expect(useStore.getState().panes).toHaveLength(1);
});

it("still commits a normal pointer release", async () => {
  fixture();
  const to = await start();
  await mouse.release(to.x, to.y);
  expect(useStore.getState().panes).toHaveLength(2);
  expect(useStore.getState().draggingTabId).toBeNull();
});

it.each(["capture", "blur", "unmount"])("cleans up an interrupted drag on %s", async (reason) => {
  const mounted = fixture();
  const to = await start();
  if (reason === "capture") {
    // Real capture, deliberately interrupted through the browser API.
    document.querySelector(".tabstrip")!.releasePointerCapture(1);
    await mouse.moveTo(to.x - 1, to.y);
  } else if (reason === "blur") {
    window.dispatchEvent(new Event("blur"));
  } else mounted.render(null);
  await twoFrames();
  expect(useStore.getState().draggingTabId).toBeNull();
  expect(document.querySelector(".tab-drag-ghost")).toBeNull();
  await mouse.release(to.x, to.y);
  expect(useStore.getState().panes).toHaveLength(1);
});

it("restores the original order when cancelling a live reorder", async () => {
  fixture();
  const from = pagePoint(document.querySelector(".tab")!);
  const to = pagePoint(document.querySelectorAll(".tab")[1], 0.95);
  await mouse.press(from.x, from.y);
  await mouse.moveTo(to.x, to.y);
  expect(useStore.getState().tabs[0].info.id).toBe("second");
  await userEvent.keyboard("{Escape}");
  await mouse.release(to.x, to.y);
  expect(useStore.getState().tabs.map((tab) => tab.info.id)).toEqual(["first", "second"]);
});
