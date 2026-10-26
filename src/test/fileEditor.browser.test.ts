import { createElement as h } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mount, browserAfterEach } from "./browserHarness";
import { FileEditorDialog } from "../components/FileEditorDialog";
import { openFileEditor, useFileEditor } from "../fileEditor";
import { useStore } from "../store";
import * as api from "../workbench/api";
import "../styles.css";

vi.mock("../workbench/api", () => ({
  readText: vi.fn(async () => ({
    path: "/etc/example.conf",
    content: "enabled=true\n",
    hash: "first",
    size: 13,
    encoding: "UTF-8",
    eol: "lf",
    bom: false,
    modifiedAt: null,
    permissions: null,
  })),
  writeText: vi.fn(async () => ({
    path: "/etc/example.conf",
    hash: "second",
    size: 14,
    uncertain: false,
    backup: null,
    temp: null,
    note: "",
  })),
}));
vi.mock("../nativeDialog", () => ({ ask: vi.fn(async () => false) }));
const initial = useStore.getState();
const editorInitial = useFileEditor.getState();
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

for (const [width, height] of [
  [1100, 720],
  [900, 560],
]) {
  it(`edits and saves directly to a named server at ${width} × ${height}`, async () => {
    await page.viewport(width, height);
    mount(h(FileEditorDialog));
    await openFileEditor("server-id", "/etc/example.conf");
    await expect.poll(() => document.querySelector(".cm-content")).not.toBeNull();
    await userEvent.fill(document.querySelector<HTMLElement>(".cm-content")!, "enabled=false\n");
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    expect(useFileEditor.getState().content).toBe("enabled=false\n");
    const save = page.getByRole("button", { name: "Save to server", exact: true });
    expect(save.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    await page.screenshot({ path: `../../artifacts/usability/file-editor-${width}.png` });
    await userEvent.click(save);
    await expect.poll(() => vi.mocked(api.writeText).mock.calls.length).toBe(1);
    expect(api.writeText).toHaveBeenCalledWith(
      "server-id",
      expect.objectContaining({
        path: "/etc/example.conf",
        expectedHash: "first",
        content: "enabled=false\n",
      }),
    );
    await expect.element(page.getByRole("status")).toHaveTextContent("Saved");
  });
}
