import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { useStore } from "../store";
import type { FileEntry } from "../types";
import { DeleteEntryDialog } from "./DeleteEntryDialog";

// The confirmation used to assemble its sentence in JSX and branch on the
// language name for the space between its verb and the kind word. The catalogue
// owns that now, so this pins what the user actually reads in both languages.
const entry = {
  name: "report.txt",
  path: "/data/report.txt",
  isDir: false,
  isSymlink: false,
  size: 12,
  modified: 0,
  mode: 0,
} as unknown as FileEntry;

const initialState = useStore.getState();
let root: Root;

const mount = () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(
      h(DeleteEntryDialog, {
        entry,
        location: "local",
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState({ ...initialState, language: "en" }, true);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  useStore.setState(initialState, true);
});

it("speaks the English sentence the catalogue holds", () => {
  mount();
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("Delete file report.txt?");
});

it("joins the words the way Chinese does", () => {
  useStore.setState({ language: "zh-CN" });
  mount();
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("删除文件report.txt？");
});
