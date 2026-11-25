import { createElement as h, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { useFileTransfers } from "../fileTransfers";
import { useStore, type Tab } from "../store";
import { clippedTextIssues, targetSizeIssues, textContrastIssues } from "../uiAudit";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * The status-bar popovers: transfers and SSH tunnels. They are the surfaces a
 * reader opens in the middle of an operation, and they were never measured —
 * the shell gate opens no popover. Same three properties as everywhere else.
 *
 * Boundary: Chromium over a controlled IPC stub, empty lists (nothing running).
 */

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string) {
    if (command === "list_port_forwards") return [scenario === "failed" ? FAILED_FORWARD : FORWARD];
    if (command === "list_file_transfers")
      return [scenario === "failed" ? FAILED_TRANSFER : TRANSFER];
    if (command === "discover_listening_ports")
      return {
        status: "ok",
        ports: [
          { host: "0.0.0.0", port: 8000, process: "python3" },
          { host: "127.0.0.1", port: 5432, process: "postgres" },
          { host: "::", port: 6379, process: "redis-server" },
        ],
        truncated: false,
      };
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    if (command === "session_cwd") return "/srv";
    return null;
  },
};

const TRANSFER = {
  revision: 1,
  id: "job-1",
  sessionId: "popover-session",
  name: "logs.tar",
  context: null,
  status: "running",
  phase: "transferring",
  transferred: 1024,
  total: 4096,
  completedFiles: 1,
  totalFiles: 3,
  failedFiles: [],
  error: null,
  attempt: 1,
  options: { requests: 4, chunkKib: 256, files: 3 },
};
const FORWARD = {
  id: "fwd-1",
  owner: "popover-session",
  address: "build@fixture:22",
  spec: {
    direction: "local",
    listenHost: "127.0.0.1",
    listenPort: 8081,
    targetHost: "db.internal",
    targetPort: 5432,
  },
  status: "listening",
  error: null,
  connections: 2,
  sentBytes: 4096,
  receivedBytes: 8192,
};

const FAILED_TRANSFER = {
  ...TRANSFER,
  id: "job-failed",
  name: "backup.tar",
  status: "failed",
  phase: "transferring",
  transferred: 0,
  total: 4096,
  completedFiles: 0,
  failedFiles: ["backup.tar"],
  error: { message: "permission denied" },
};
const FAILED_FORWARD = {
  ...FORWARD,
  id: "fwd-failed",
  status: "error",
  error: "bind: address already in use",
};

/** Which data the stub reports; each test picks one. */
let scenario: "ok" | "failed" = "ok";

const initial = useStore.getState();
const ID = "popover-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "build",
    kind: "ssh",
    protocol: "ssh",
    profileId: null,
    address: "build@fixture:22",
    color: null,
    supportsRemoteFiles: true,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-pop", name: "build", kind: "ssh" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

const show = (issue: { path: string; detail: string; text: string }) =>
  issue.path + " | " + issue.detail + " | " + issue.text;

const openPopover = async (label: string) => {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button.status-item"),
  ).find((node) => (node.textContent ?? "").trim().startsWith(label));
  expect(button, label + " status button").toBeTruthy();
  await userEvent.click(button!);
  await until(() => document.querySelector(".status-popover") !== null);
  await twoFrames();
  return document.querySelector<HTMLElement>(".status-popover")!;
};

const closePopover = async (label: string) => {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button.status-item"),
  ).find((node) => (node.textContent ?? "").trim().startsWith(label));
  await userEvent.click(button!);
  await until(() => document.querySelector(".status-popover") === null);
  await twoFrames();
};

const audit = (root: HTMLElement, label: string) => {
  const contrast = textContrastIssues(root);
  const targets = targetSizeIssues(root);
  const clips = clippedTextIssues(root);
  expect(contrast.issues.map(show), label + " contrast").toEqual([]);
  expect(targets.issues.map(show), label + " targets").toEqual([]);
  expect(clips.issues.map(show), label + " clips").toEqual([]);
  expect(contrast.inspected + contrast.indeterminate, label + " text").toBeGreaterThan(2);
  expect(targets.inspected, label + " targets").toBeGreaterThan(1);
  const close = root.querySelector<HTMLElement>(".status-popover-close")!;
  expect(close.getBoundingClientRect().height, label + " close button").toBeGreaterThanOrEqual(24);
};

describe("status popovers", () => {
  afterEach(async () => {
    await browserAfterEach();
    useStore.setState(initial, true);
  });

  it("keeps the transfers and tunnels popovers readable and hittable", async () => {
    await page.viewport(1440, 900);
    useStore.setState({
      ...initial,
      tabs: [tab()],
      activeId: ID,
      panes: [{ id: "root", activeTabId: ID }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      panels: { sessions: false, filer: false, sender: false },
      gpuRenderer: false,
    });
    useStore.getState().setLanguage("en");
    useFileTransfers.setState({ jobs: {} });
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();

    // Populated, not just empty: the row controls are the reason to measure
    // these surfaces at all.
    const transfers = await openPopover("Transfers");
    expect(transfers.textContent, "the running job is listed").toContain("logs.tar");
    audit(transfers, "transfers");
    await closePopover("Transfers");

    const tunnels = await openPopover("Tunnels");
    expect(tunnels.textContent, "the listening rule is listed").toContain("db.internal");
    audit(tunnels, "tunnels");
    await closePopover("Tunnels");
  });

  it("keeps the failed states readable and hittable", async () => {
    scenario = "failed";
    await page.viewport(1440, 900);
    useStore.setState({
      ...initial,
      tabs: [tab()],
      activeId: ID,
      panes: [{ id: "root", activeTabId: ID }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      panels: { sessions: false, filer: false, sender: false },
      gpuRenderer: false,
    });
    useStore.getState().setLanguage("en");
    useFileTransfers.setState({ jobs: {} });
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();

    const transfers = await openPopover("Transfers");
    expect(transfers.textContent, "the failure reason is shown").toContain("permission denied");
    audit(transfers, "failed transfers");
    await closePopover("Transfers");

    const tunnels = await openPopover("Tunnels");
    expect(tunnels.textContent, "the binding error is shown").toContain("address already in use");
    audit(tunnels, "failed tunnels");
    await closePopover("Tunnels");
    scenario = "ok";
  });

  it("keeps the tunnel list visible when discovery expands on a short viewport", async () => {
    scenario = "ok";
    await page.viewport(900, 500);
    useStore.setState({
      ...initial,
      tabs: [tab()],
      activeId: ID,
      panes: [{ id: "root", activeTabId: ID }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      panels: { sessions: false, filer: false, sender: false },
      gpuRenderer: false,
    });
    useStore.getState().setLanguage("en");
    useFileTransfers.setState({ jobs: {} });
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();

    const tunnels = await openPopover("Tunnels");
    const toggle = tunnels.querySelector<HTMLButtonElement>(".forward-discovery-toggle")!;
    await userEvent.click(toggle);
    await until(() => tunnels.querySelectorAll(".forward-listener").length > 0);
    await twoFrames();

    const jobsBox = tunnels.querySelector<HTMLElement>(".forward-jobs")!;
    const listenersBox = tunnels.querySelector<HTMLElement>(".forward-listeners")!;
    expect(
      jobsBox.getBoundingClientRect().height,
      "active tunnels list must not collapse when discovery opens",
    ).toBeGreaterThanOrEqual(76);
    expect(
      listenersBox.getBoundingClientRect().height,
      "discovered remote-port list must stay usable",
    ).toBeGreaterThanOrEqual(68);
  });
});
