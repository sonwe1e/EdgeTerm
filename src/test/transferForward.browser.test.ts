import { createElement as h, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { useFileTransfers } from "../fileTransfers";
import { useStore } from "../store";
import {
  clippedTextIssues,
  focusRingIssues,
  targetSizeIssues,
  textContrastIssues,
} from "../uiAudit";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * The status bar's two list surfaces: the transfer centre and the tunnel
 * centre. Both are dense (rows, badges, in-row controls) and neither had been
 * measured, so contrast, target size, clipping and keyboard focus are read
 * here at a laptop size in both themes.
 */

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string) {
    if (command === "plugin:event|listen") return ++serial;
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    if (command.startsWith("list_")) return [];
    return null;
  },
};

const initial = useStore.getState();
const transfersInitial = useFileTransfers.getState();

const transfer = (id: string, status: string, name: string) => ({
  revision: 1,
  id,
  sessionId: "s-1",
  name,
  context: null,
  status,
  phase: "transfer",
  transferred: status === "running" ? 2_400_000 : 8_000_000,
  total: 8_000_000,
  completedFiles: status === "running" ? 1 : 4,
  totalFiles: 4,
  failedFiles: [],
  error: status === "failed" ? { kind: "io", message: "connection reset by peer" } : null,
  attempt: 1,
  options: { rateLimitBps: 0, preserveTimestamps: true, followLinks: false, permissions: false },
});

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(40);
};

const withMotionFrozen = async <T>(run: () => T): Promise<T> => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  try {
    return run();
  } finally {
    style.remove();
  }
};

const describeIssue = (issue: { path: string; detail: string; text: string }) =>
  issue.path + " | " + issue.detail + " | " + issue.text;

const audit = async (root: HTMLElement, label: string) => {
  // Keyboard modality only; the popover may keep focus on its trigger, which
  // is fine — the sweep focuses each stop itself.
  await userEvent.keyboard("{Tab}");
  await twoFrames();
  await withMotionFrozen(() => {
    const contrast = textContrastIssues(root);
    const targets = targetSizeIssues(root);
    const clips = clippedTextIssues(root);
    expect(contrast.issues.map(describeIssue), label + " contrast").toEqual([]);
    expect(targets.issues.map(describeIssue), label + " targets").toEqual([]);
    expect(clips.issues.map(describeIssue), label + " clipped labels").toEqual([]);
    expect(
      contrast.inspected + contrast.indeterminate,
      label + " text inspected (few readable text nodes is a real limit of a form panel)",
    ).toBeGreaterThan(0);
    expect(targets.inspected, label + " targets inspected").toBeGreaterThan(0);
  });
  const sweep = await withMotionFrozen(() => focusRingIssues(root));
  expect(sweep.inspected, label + " focus stops").toBeGreaterThan(0);
  expect(sweep.issues.map(describeIssue), label + " focus rings").toEqual([]);
};

const openStatusItem = async (prefix: string) => {
  const items = Array.from(document.querySelectorAll<HTMLElement>(".status-item"));
  const item = items.find((node) => (node.textContent ?? "").trim().startsWith(prefix));
  expect(item, prefix + " status item").toBeDefined();
  await userEvent.click(item!);
  await twoFrames();
  return item!;
};

describe("status bar surfaces", () => {
  beforeEach(() => {
    localStorage.clear();
    useFileTransfers.setState(transfersInitial, true);
    useFileTransfers
      .getState()
      .update(transfer("t-run", "running", "dataset-2026-11.tar") as never);
    useFileTransfers.getState().update(transfer("t-fail", "failed", "backup-db.sql.gz") as never);
  });

  afterEach(async () => {
    await browserAfterEach();
    useStore.setState(initial, true);
    useFileTransfers.setState(transfersInitial, true);
  });

  it("keeps the transfer centre readable, hittable and focusable in both themes", async () => {
    await page.viewport(900, 560);
    useStore.setState({ ...initial, gpuRenderer: false });
    useStore.getState().setLanguage("en");
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    await openStatusItem("Transfers");
    await until(() => document.querySelector(".transfer-center-popover") !== null);
    const panel = document.querySelector<HTMLElement>(".transfer-center-popover");
    expect(panel, "the transfer centre is open").not.toBeNull();
    for (const theme of ["dark", "light"] as const) {
      // One mount, two themes: remounting per theme left two App trees whose
      // status items fought over the same popover.
      useStore.getState().setTheme(theme);
      await twoFrames();
      await audit(panel!, "transfer centre " + theme);
    }
    expect(
      panel!.querySelectorAll(".transfer-job").length,
      "both seeded jobs are listed",
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps the tunnel centre readable, hittable and focusable", async () => {
    await page.viewport(900, 560);
    useStore.setState({ ...initial, gpuRenderer: false });
    useStore.getState().setLanguage("en");
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    await openStatusItem("Tunnels");
    await until(() => document.querySelector(".forward-popover") !== null);
    const panel = document.querySelector<HTMLElement>(".forward-popover")!;
    await audit(panel, "tunnel centre");
    // The add-rule form only exists with a live SSH session, which this
    // fixture does not have; what is measurable here is the panel itself.
    expect(
      (panel.textContent ?? "").trim().length,
      "the tunnel popover says something rather than rendering blank",
    ).toBeGreaterThan(0);
    const fields = Array.from(panel.querySelectorAll<HTMLInputElement>("input"));
    for (const field of fields) {
      const labelled =
        field.getAttribute("aria-label") ??
        (field.id ? panel.querySelector(`label[for="${field.id}"]`)?.textContent : null) ??
        field.closest("label")?.textContent;
      expect((labelled ?? "").trim().length, "field " + field.name + " has a name").toBeGreaterThan(
        0,
      );
    }
  });
});
