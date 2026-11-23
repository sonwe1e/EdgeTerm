// IX-03 — the FTP/SFTP dual-pane lists were pointer-only: the listbox had no
// tabIndex, no aria-activedescendant and no key handling, so a keyboard or
// screen-reader user could not select, enter or act on any entry in the file
// transfer workspace. The regression: the list is one Tab stop, the arrow keys
// move a cursor that aria announces, selection follows the cursor, and Enter
// takes the double-click's own path.
import { createElement as h, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import { useStore } from "../store";
import { EMPTY_SELECTION, type FileSelection } from "../fileBatch";
import { FileBrowser } from "../components/ftpPresentation";
import type { FileEntry } from "../types";

afterEach(async () => {
  await browserAfterEach();
  vi.restoreAllMocks();
});

const entry = (name: string, isDir = false): FileEntry => ({
  name,
  path: `/remote/${name}`,
  isDir,
  isSymlink: false,
  size: 100,
  modified: 1700000000,
  permissions: null,
  owner: null,
  group: null,
});
const entries = [entry("folder-a", true), entry("file-b.txt"), entry("file-c.txt")];
const optionId = (path: string) => `ftp-option-remote-${encodeURIComponent(path)}`;

const browser = (overrides: Record<string, unknown> = {}) => ({
  title: "SFTP 服务器",
  subtitle: "fileserver.example.com:22",
  path: "/remote",
  draft: "/remote",
  entries,
  selection: EMPTY_SELECTION,
  loading: false,
  error: null,
  side: "remote" as const,
  onItemPointerDown: vi.fn(),
  onItemPointerMove: vi.fn(),
  onItemPointerUp: vi.fn(),
  onDragCancel: vi.fn(),
  draggingPath: null,
  dropHover: null,
  onDraftChange: vi.fn(),
  onOpenPath: vi.fn(),
  onHome: vi.fn(),
  onParent: vi.fn(),
  onRefresh: vi.fn(),
  onSelectionChange: vi.fn(),
  onActivate: vi.fn(),
  ...overrides,
});

/** The pane the way FtpPane holds it: the selection is the pane's, fed back. */
function StatefulBrowser() {
  const [selection, setSelection] = useState<FileSelection>(EMPTY_SELECTION);
  return h(FileBrowser, browser({ selection, onSelectionChange: setSelection }));
}

const list = () => document.querySelector<HTMLDivElement>('.ftp-browser-list[role="listbox"]')!;

/** The pane whose folder changes, to prove the filter belongs to one folder. */
function PathChangingBrowser() {
  const [selection, setSelection] = useState<FileSelection>(EMPTY_SELECTION);
  const [path, setPath] = useState("/remote");
  return h(
    "div",
    null,
    h("button", { type: "button", id: "go-next", onClick: () => setPath("/next") }, "next"),
    h(FileBrowser, browser({ path, draft: path, selection, onSelectionChange: setSelection })),
  );
}

describe("FTP/SFTP dual-pane filter", () => {
  it("narrows the listing in place, and Escape gives it back", async () => {
    useStore.getState().setLanguage("en");
    mount(h(StatefulBrowser));
    await twoFrames();

    const filter = document.querySelector<HTMLInputElement>(".ftp-file-browser .filer-filter")!;
    expect(filter, "the pane offers a filter").not.toBeNull();
    filter.focus();
    await userEvent.keyboard("file-b");
    await twoFrames();
    const names = () =>
      [...document.querySelectorAll(".ftp-browser-list .ftp-file-name")].map(
        (node) => node.textContent,
      );
    expect(names()).toEqual(["file-b.txt"]);
    expect(document.querySelector(".filer-filter-count")?.textContent).toBe("1 of 3");

    await userEvent.keyboard("{Escape}");
    await twoFrames();
    expect(filter.value).toBe("");
    expect(names().length).toBe(3);
  });
});

describe("FTP/SFTP dual-pane filter scope", () => {
  it("drops the filter when the pane walks into another folder", async () => {
    useStore.getState().setLanguage("en");
    mount(h(PathChangingBrowser));
    await twoFrames();
    const filter = document.querySelector<HTMLInputElement>(".ftp-file-browser .filer-filter")!;
    filter.focus();
    await userEvent.keyboard("file-b");
    await twoFrames();
    const names = () =>
      [...document.querySelectorAll(".ftp-browser-list .ftp-file-name")].map(
        (node) => node.textContent,
      );
    expect(names()).toEqual(["file-b.txt"]);

    await userEvent.click(document.querySelector<HTMLButtonElement>("#go-next")!);
    await twoFrames();
    await twoFrames();
    expect(document.querySelector<HTMLInputElement>(".filer-filter")?.value).toBe("");
    expect(names().length, "the new folder is listed whole").toBe(3);
  });
});

describe("FTP/SFTP dual-pane filter key", () => {
  it("opens the pane's filter with the slash key from the list", async () => {
    useStore.getState().setLanguage("en");
    mount(h(StatefulBrowser));
    await twoFrames();
    list().focus();
    await twoFrames();
    await userEvent.keyboard("/");
    await twoFrames();
    expect(document.activeElement).toBe(document.querySelector(".ftp-file-browser .filer-filter"));
  });
});

describe("FTP/SFTP dual-pane keyboard (IX-03)", () => {
  it("is one Tab stop whose cursor aria announces, with selection following it", async () => {
    mount(h(StatefulBrowser));
    await twoFrames();

    expect(list().tabIndex).toBe(0);
    // Rows are not Tab stops of their own; the list is the single stop.
    const row = document.getElementById(optionId("/remote/file-b.txt"))!;
    expect(row.getAttribute("role")).toBe("option");
    expect(row.tabIndex).toBe(-1);

    list().focus();
    await userEvent.keyboard("{ArrowDown}");
    await twoFrames();
    expect(list().getAttribute("aria-activedescendant")).toBe(optionId("/remote/folder-a"));
    expect(
      document.getElementById(optionId("/remote/folder-a"))?.getAttribute("aria-selected"),
    ).toBe("true");

    await userEvent.keyboard("{ArrowDown}");
    await twoFrames();
    expect(list().getAttribute("aria-activedescendant")).toBe(optionId("/remote/file-b.txt"));
    expect(
      document.getElementById(optionId("/remote/file-b.txt"))?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      document.getElementById(optionId("/remote/folder-a"))?.getAttribute("aria-selected"),
    ).toBe("false");

    await userEvent.keyboard("{Home}");
    await twoFrames();
    expect(list().getAttribute("aria-activedescendant")).toBe(optionId("/remote/folder-a"));
    await userEvent.keyboard("{End}");
    await twoFrames();
    expect(list().getAttribute("aria-activedescendant")).toBe(optionId("/remote/file-c.txt"));
  });

  it("enters a folder on Enter through the double-click's own path", async () => {
    const onActivate = vi.fn();
    mount(h(FileBrowser, browser({ onActivate })));
    await twoFrames();

    list().focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await twoFrames();
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/remote/folder-a",
        isDir: true,
      }),
    );
  });

  it("dispatches the menu key on the cursor row, the way the Filer panel does", async () => {
    mount(h(FileBrowser, browser()));
    await twoFrames();

    const row = document.getElementById(optionId("/remote/folder-a"))!;
    const seen: Event[] = [];
    row.addEventListener("contextmenu", (event) => seen.push(event));
    list().focus();
    await userEvent.keyboard("{ArrowDown}{ContextMenu}");
    await twoFrames();

    // The pane has no row menu yet, so nothing answers; the dispatch itself
    // is the contract a future menu plugs into (see useFileListKeyboard).
    expect(seen).toHaveLength(1);
    expect(seen[0].bubbles).toBe(true);
  });
});
