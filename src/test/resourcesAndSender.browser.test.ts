import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { useStore, type Tab } from "../store";
import { clippedTextIssues, targetSizeIssues, textContrastIssues } from "../uiAudit";
import type { ResourceMetrics } from "../api";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * Two surfaces that were never measured: the host-resources popover (a
 * sparkline cluster with device rows) and the sender panel's command strip.
 *
 * Boundary: Chromium over a controlled IPC stub; the sample is a fixture, so
 * this grades the drawing, not a real host's numbers.
 */

const GiB = 1024 * 1024 * 1024;
const SAMPLE: ResourceMetrics = {
  status: "ok",
  cpuPercent: 37.5,
  cpuStatus: "ok",
  memory: { usedBytes: 6 * GiB, totalBytes: 16 * GiB },
  memoryStatus: "ok",
  capacity: { usedBytes: 120 * GiB, totalBytes: 256 * GiB, mount: "/" },
  capacityStatus: "ok",
  diskReadBps: 1024,
  diskWriteBps: 512,
  diskStatus: "ok",
  networkReceiveBps: 2048,
  networkSendBps: 1024,
  networkStatus: "ok",
  gpus: [
    {
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      utilization: 40,
      usedBytes: GiB,
      totalBytes: 8 * GiB,
      temperature: 55,
    },
  ],
  gpuStatus: "ok",
  npus: [
    {
      index: 0,
      name: "910B3",
      utilization: 12,
      usedBytes: 3 * GiB,
      totalBytes: 64 * GiB,
      temperature: 48,
    },
  ],
  npuStatus: "ok",
};

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string) {
    if (command === "sample_resources") return SAMPLE;
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    return null;
  },
};

const initial = useStore.getState();
const ID = "metrics-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "web",
    kind: "ssh",
    protocol: "ssh",
    profileId: null,
    address: "root@web.internal:22",
    color: null,
    supportsRemoteFiles: true,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-web", name: "web", kind: "ssh" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const until = async (predicate: () => boolean, timeoutMs = 6000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

const describeIssue = (issue: { path: string; detail: string; text: string }) =>
  issue.path + " | " + issue.detail + " | " + issue.text;

const audit = (root: HTMLElement, label: string, textFloor: number, targetFloor: number) => {
  const contrast = textContrastIssues(root);
  const targets = targetSizeIssues(root);
  const clips = clippedTextIssues(root);
  expect(contrast.issues.map(describeIssue), label + " contrast").toEqual([]);
  expect(targets.issues.map(describeIssue), label + " targets").toEqual([]);
  expect(clips.issues.map(describeIssue), label + " clips").toEqual([]);
  expect(contrast.inspected + contrast.indeterminate, label + " text").toBeGreaterThan(textFloor);
  expect(targets.inspected, label + " targets").toBeGreaterThanOrEqual(targetFloor);
};

const mountApp = async (sender: boolean) => {
  await page.viewport(1440, 900);
  useStore.setState({
    ...initial,
    tabs: [tab()],
    activeId: ID,
    panes: [{ id: "root", activeTabId: ID }],
    layout: { kind: "leaf", paneId: "root" },
    activePaneId: "root",
    panels: { sessions: false, filer: false, sender },
    panelDocks: { left: ["sessions"], right: ["filer"], bottom: ["sender"] },
    gpuRenderer: false,
  });
  useStore.getState().setLanguage("en");
  mount(h(App));
  await twoFrames();
  await twoFrames();
};

describe("resources and sender", () => {
  afterEach(async () => {
    await browserAfterEach();
    useStore.setState(initial, true);
  });

  it("keeps the host-resources popover readable and hittable", async () => {
    await mountApp(false);
    await expect
      .poll(() => document.querySelector<HTMLElement>(".resource-summary"))
      .not.toBeNull();
    await userEvent.click(document.querySelector<HTMLButtonElement>(".resource-summary")!);
    await until(() => document.querySelector(".monitor-popover") !== null);
    await twoFrames();
    const popover = document.querySelector<HTMLElement>(".monitor-popover")!;
    expect(popover, "the resources popover").not.toBeNull();
    // The fixture's devices are drawn, not merely promised.
    expect(popover.textContent).toContain("RTX 4090");
    audit(popover, "resources", 6, 2);
    const close = popover.querySelector<HTMLElement>(".status-popover-close")!;
    // DOMRect can lose a fraction of a thousandth of a pixel in the popover transform.
    const height = close.getBoundingClientRect().height;
    expect(Math.round(height * 1000) / 1000, "close target").toBeGreaterThanOrEqual(24);
  });

  it("keeps the sender panel readable and hittable", async () => {
    await mountApp(true);
    await until(() => document.querySelector('[data-panel="sender"]') !== null);
    await twoFrames();
    const panel = document.querySelector<HTMLElement>('[data-panel="sender"]')!;
    expect(panel, "the sender panel").not.toBeNull();
    audit(panel, "sender", 2, 3);
  });
});
