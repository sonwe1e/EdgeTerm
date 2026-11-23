import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { FileEditorDialog } from "../components/FileEditorDialog";
import { openFileEditor, useFileEditor } from "../fileEditor";
import { ask } from "../nativeDialog";
import * as api from "../editor/textFile";
import { useStore } from "../store";
import {
  clippedTextIssues,
  focusRingContrastIssues,
  focusRingIssues,
  targetSizeIssues,
  textContrastIssues,
} from "../uiAudit";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

/**
 * The file editor's own surface: a modal that holds a CodeMirror instance and
 * a small chrome around it. It is the one dialog that carries an editor rather
 * than a form, and its hint text, gutter and footer buttons were never
 * measured.
 *
 * Boundary: Chromium, mocked text IPC, the dialog mounted on its own.
 */
vi.mock("../editor/textFile", () => ({
  readText: vi.fn(async () => ({
    path: "/etc/example.conf",
    content: "# managed by the app\nenabled=true\nworkers = 4\n",
    hash: "first",
    size: 44,
    encoding: "UTF-8",
    eol: "lf",
    bom: false,
    modifiedAt: null,
    permissions: null,
  })),
  writeText: vi.fn(async () => ({
    path: "/etc/example.conf",
    hash: "second",
    size: 45,
    uncertain: false,
    backup: null,
    temp: null,
    note: "",
  })),
}));
vi.mock("../nativeDialog", () => ({ ask: vi.fn(async () => false) }));

const initial = useStore.getState();
const editorInitial = useFileEditor.getState();

const describeIssue = (issue: { path: string; detail: string; text: string }) =>
  issue.path + " | " + issue.detail + " | " + issue.text;

/** Freezes transitions so a snapshot never reads a half-faded state. */
const withMotionFrozen = async <T>(run: () => T): Promise<T> => {
  const style = document.createElement("style");
  style.textContent =
    "*, *::before, *::after { transition: none !important; animation: none !important; }";
  document.head.append(style);
  try {
    return run();
  } finally {
    style.remove();
  }
};

beforeEach(() => {
  useFileEditor.setState(editorInitial, true);
  useStore.getState().setLanguage("en");
  vi.clearAllMocks();
});

afterEach(async () => {
  await browserAfterEach();
  useFileEditor.setState(editorInitial, true);
  useStore.setState(initial, true);
  useStore.getState().setLanguage(initial.language);
});

describe("file editor surface", () => {
  for (const theme of ["dark", "light"] as const) {
    it("stays readable and hittable in the " + theme + " theme", async () => {
      await page.viewport(1100, 720);
      useStore.setState({ theme });
      mount(h(FileEditorDialog));
      await openFileEditor("server-id", "/etc/example.conf");
      await expect.poll(() => document.querySelector(".cm-content")).not.toBeNull();
      await twoFrames();
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
      expect(dialog, "the editor dialog").not.toBeNull();

      const contrast = textContrastIssues(dialog);
      const targets = targetSizeIssues(dialog);
      const clips = clippedTextIssues(dialog);
      expect(contrast.issues.map(describeIssue), theme + " text contrast").toEqual([]);
      expect(targets.issues.map(describeIssue), theme + " target sizes").toEqual([]);
      expect(clips.issues.map(describeIssue), theme + " clipped text").toEqual([]);
      expect(contrast.inspected, theme + " text measured").toBeGreaterThan(3);
      // The dialog's own chrome is two buttons (Close, Save); the editor body
      // is CodeMirror's, and its internals are not app targets.
      expect(targets.inspected, theme + " targets measured").toBeGreaterThanOrEqual(2);

      // The editor's own controls are real targets, not decoration.
      for (const name of ["Close", "Save to server"]) {
        const button = Array.from(dialog.querySelectorAll<HTMLElement>("button")).find(
          (node) =>
            (node.textContent ?? "").trim() === name || node.getAttribute("aria-label") === name,
        );
        expect(button, name + " button").toBeTruthy();
        const box = button!.getBoundingClientRect();
        expect(box.height, name + " height").toBeGreaterThanOrEqual(24);
        expect(box.width, name + " width").toBeGreaterThanOrEqual(24);
      }

      // Every focus stop inside the dialog must look focused.
      await userEvent.keyboard("{Tab}");
      await twoFrames();
      const sweep = await withMotionFrozen(() => focusRingIssues(dialog));
      expect(sweep.inspected, theme + " focus stops").toBeGreaterThan(2);
      expect(sweep.issues.map(describeIssue), theme + " focus stops").toEqual([]);
      const rings = await withMotionFrozen(() => focusRingContrastIssues(dialog));
      expect(rings.inspected, theme + " ring colours").toBeGreaterThan(0);
      expect(rings.issues.map(describeIssue), theme + " ring contrast").toEqual([]);
    });
  }

  it("refuses to throw away unsaved edits, and closes once the reader agrees", async () => {
    await page.viewport(1100, 720);
    mount(h(FileEditorDialog));
    await openFileEditor("server-id", "/etc/example.conf");
    await expect.poll(() => document.querySelector(".cm-content")).not.toBeNull();
    await userEvent.fill(document.querySelector<HTMLElement>(".cm-content")!, "workers = 8\n");

    // Declining the warning keeps the buffer and the dialog.
    vi.mocked(ask).mockResolvedValueOnce(false);
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    await twoFrames();
    expect(vi.mocked(ask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ask).mock.calls[0][1]).toEqual({ kind: "warning" });
    expect(useFileEditor.getState().target, "still open").not.toBeNull();
    expect(document.querySelector("dialog[open]")).not.toBeNull();
    expect(useFileEditor.getState().content).toBe("workers = 8\n");

    // Agreeing closes it and forgets the buffer.
    vi.mocked(ask).mockResolvedValueOnce(true);
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    await expect.poll(() => useFileEditor.getState().target).toBeNull();
    await twoFrames();
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  it("saves with the chord the dialog prints", async () => {
    await page.viewport(1100, 720);
    mount(h(FileEditorDialog));
    await openFileEditor("server-id", "/etc/example.conf");
    await expect.poll(() => document.querySelector(".cm-content")).not.toBeNull();
    // The hint under the path promises Ctrl+S; a hint that lies is worse than
    // none, so the promise is pressed rather than assumed.
    await userEvent.fill(document.querySelector<HTMLElement>(".cm-content")!, "workers = 8\n");
    await userEvent.keyboard("{Control>}s{/Control}");
    await expect.poll(() => vi.mocked(api.writeText).mock.calls.length).toBe(1);
    expect(api.writeText).toHaveBeenCalledWith(
      "server-id",
      expect.objectContaining({ path: "/etc/example.conf", content: "workers = 8\n" }),
    );
    await expect.element(page.getByRole("status")).toHaveTextContent("Saved");
    // And the chord never reaches the document itself.
    expect(useFileEditor.getState().content).toBe("workers = 8\n");
  });
});
