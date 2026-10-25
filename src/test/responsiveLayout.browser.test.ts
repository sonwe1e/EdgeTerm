import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mouse, mount, pagePoint, twoFrames, wait } from "./browserHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

// Real Chromium, real stylesheet, real dual-pane geometry: the browser
// project runs without the jsdom stubs. The production component here is
// FtpPane — the dual-pane browser with its 800px columns breakpoint and its
// pointer-capture drag — plus ResourceMonitorBar for the 1100px breakpoint.
// Drags go through the same real CDP pointer chain the VirtualFileRows
// capture contracts use, so the production setPointerCapture path engages.
//
// Controlled IPC boundary (scripts/README wording): the api module is
// replaced by recording stubs over the real module shape, with a fixed
// synthetic listing; the drag and layout behaviour of the front end is what
// is proven — not real transfers, not a real server, not WebView2 or other
// engines. The store → FilerPanel → rows font chain has its own
// production-build gate in scripts/check-app-font-chain.mjs.
import "../styles.css";
import { FtpPane } from "../components/FtpPane";
import { ResourceMonitorBar } from "../components/ResourceMonitorBar";
import type { Tab } from "../store";

vi.mock("../api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api")>();
  const listing = (path: string, side: "local" | "remote") => ({
    path,
    entries: [
      {
        name: "folder",
        path: `${path}/folder`,
        isDir: true,
        isSymlink: false,
        size: 0,
        modified: 1_700_000_000,
        permissions: null,
        owner: null,
        group: null,
      },
      {
        name: side === "local" ? "file-local.txt" : "file-remote.txt",
        path: `${path}/${side === "local" ? "file-local.txt" : "file-remote.txt"}`,
        isDir: false,
        isSymlink: false,
        size: 42,
        modified: 1_700_000_000,
        permissions: null,
        owner: null,
        group: null,
      },
    ],
  });
  return {
    ...real,
    sftpHome: vi.fn(async () => "/remote"),
    localHome: vi.fn(async () => "/local"),
    sftpList: vi.fn(async (_id: string, p: string) => listing(p, "remote")),
    localList: vi.fn(async (p: string) => listing(p, "local")),
    localParent: vi.fn(async () => "/"),
    newTransferId: vi.fn(() => `transfer-${Math.random().toString(36).slice(2)}`),
    transferFiles: vi.fn(async () => undefined),
    sftpMkdir: vi.fn(async () => undefined),
    sftpRename: vi.fn(async () => undefined),
    sftpRemove: vi.fn(async () => undefined),
    localMkdir: vi.fn(async () => undefined),
    localRename: vi.fn(async () => undefined),
    localRemove: vi.fn(async () => undefined),
    controlFileTransfer: vi.fn(async () => undefined),
    cancelTransfer: vi.fn(async () => undefined),
    sampleResources: vi.fn(async () => {
      throw new Error("no resource sampler in this fixture");
    }),
    cancelResourceSample: vi.fn(async () => undefined),
  };
});

import * as api from "../api";

const tabFor = (id: string, kind: "sftp" | "ssh"): Tab => ({
  info: {
    id,
    profileId: null,
    name: id,
    kind,
    protocol: kind,
    address: "fixture",
    color: null,
    supportsRemoteFiles: kind === "sftp",
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: `profile-${id}`, name: id, kind },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: "responsive-pane",
});

const sftpPane = (active = true) =>
  mount(createElement(FtpPane, { tab: tabFor("responsive-sftp", "sftp"), active }));

/**
 * A real pointer drag through the CDP: press on the source row (the
 * production setPointerCapture engages), one move past the 5px threshold,
 * release over the target point. The drop hit-tests the release point.
 */
const drag = async (source: HTMLElement, target: HTMLElement): Promise<void> => {
  const from = pagePoint(source);
  const to = pagePoint(target);
  await mouse.press(from.x, from.y);
  await mouse.moveTo(from.x + 30, from.y + 10);
  await twoFrames();
  await mouse.moveTo(to.x, to.y);
  await mouse.release(to.x, to.y);
};

describe("the dual-pane browser across the 800px breakpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await browserAfterEach();
    await page.viewport(1100, 720);
  });

  it("at 1100x720 three columns align between header and rows; panes tile with the rail", async () => {
    await page.viewport(1100, 720);
    sftpPane();
    await twoFrames();

    const panes = Array.from(document.querySelectorAll<HTMLElement>(".ftp-file-browser")).map(
      (pane) => pane.getBoundingClientRect(),
    );
    expect(panes.length).toBe(2);
    // Two browsers plus the transfer rail tile the width without overlap.
    const rail = document.querySelector<HTMLElement>(".ftp-transfer-rail")!;
    const railRect = rail.getBoundingClientRect();
    expect(railRect.width).toBeGreaterThan(90);
    expect(railRect.width).toBeLessThan(120);
    expect(panes[0].right <= railRect.left + 1).toBe(true);
    expect(railRect.right <= panes[1].left + 1).toBe(true);

    // Name is left-aligned, size/modified right-aligned — header AND rows,
    // from the real computed styles.
    const header = document.querySelector<HTMLElement>(".ftp-browser-columns")!;
    const headerCells = Array.from(header.querySelectorAll<HTMLElement>("button"));
    expect(headerCells.length).toBe(3);
    const row = document.querySelector<HTMLElement>(".ftp-file-row")!;
    const rowCells = Array.from(row.querySelectorAll<HTMLElement>(":scope > span"));
    expect(rowCells.length).toBe(3);
    expect(getComputedStyle(headerCells[0]).textAlign).toBe("left");
    expect(getComputedStyle(headerCells[1]).textAlign).toBe("right");
    expect(getComputedStyle(headerCells[2]).textAlign).toBe("right");
    expect(["left", "start"]).toContain(getComputedStyle(rowCells[0]).textAlign);
    expect(getComputedStyle(rowCells[1]).textAlign).toBe("right");
    expect(getComputedStyle(rowCells[2]).textAlign).toBe("right");
    // The header column and its row column share real edges (same grid).
    for (const [head, cell] of [
      [headerCells[0], rowCells[0]],
      [headerCells[1], rowCells[1]],
      [headerCells[2], rowCells[2]],
    ] as const) {
      const headRect = head.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      expect(
        Math.abs(headRect.left - cellRect.left),
        `column ${head.textContent} left edges`,
      ).toBeLessThan(1.5);
      expect(
        Math.abs(headRect.right - cellRect.right),
        `column ${head.textContent} right edges`,
      ).toBeLessThan(1.5);
    }
    await page.screenshot({
      path: "../../.tmp/records/implementation-03/responsive-1100.png",
    });
  });

  it("at 760x600 the time column is gone, the grid narrows, alignment keeps", async () => {
    await page.viewport(760, 600);
    sftpPane();
    await twoFrames();

    const rail = document.querySelector<HTMLElement>(".ftp-transfer-rail")!;
    expect(rail.getBoundingClientRect().width).toBeLessThan(90);

    const header = document.querySelector<HTMLElement>(".ftp-browser-columns")!;
    const headerCells = Array.from(header.querySelectorAll<HTMLElement>("button"));
    const row = document.querySelector<HTMLElement>(".ftp-file-row")!;
    const rowCells = Array.from(row.querySelectorAll<HTMLElement>(":scope > span"));
    // The time column is display:none on both the header and the rows.
    expect(getComputedStyle(headerCells[2]).display).toBe("none");
    expect(getComputedStyle(rowCells[2]).display).toBe("none");
    expect(getComputedStyle(headerCells[0]).textAlign).toBe("left");
    expect(getComputedStyle(headerCells[1]).textAlign).toBe("right");
    expect(["left", "start"]).toContain(getComputedStyle(rowCells[0]).textAlign);
    expect(getComputedStyle(rowCells[1]).textAlign).toBe("right");
    // The visible columns still share real edges.
    for (const [head, cell] of [
      [headerCells[0], rowCells[0]],
      [headerCells[1], rowCells[1]],
    ] as const) {
      const headRect = head.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      expect(Math.abs(headRect.left - cellRect.left)).toBeLessThan(1.5);
      expect(Math.abs(headRect.right - cellRect.right)).toBeLessThan(1.5);
    }
    await page.screenshot({
      path: "../../.tmp/records/implementation-03/responsive-760.png",
    });
  });

  it("a real pointer drag uploads across panes; same-side drops do nothing", async () => {
    await page.viewport(1100, 720);
    sftpPane();
    await twoFrames();

    const localFile = document.querySelector<HTMLElement>(
      '[data-file-path="/local/file-local.txt"]',
    )!;
    const localFolder = document.querySelector<HTMLElement>('[data-file-path="/local/folder"]')!;
    const remoteFile = document.querySelector<HTMLElement>(
      '[data-file-path="/remote/file-remote.txt"]',
    )!;
    const remoteList = document.querySelectorAll<HTMLElement>(".ftp-browser-list")[0]!;
    const localList = document.querySelectorAll<HTMLElement>(".ftp-browser-list")[1]!;

    // Same-side drop: a local file onto a local folder — no transfer call
    // may fire (the same-side refusal, at the real drop call site).
    await drag(localFile, localFolder);
    await wait(150);
    expect(api.transferFiles).not.toHaveBeenCalled();

    // Local → remote: a real upload with the fixture paths, queued through
    // the batch transfer API as one item.
    await drag(localFile, remoteList);
    await vi.waitFor(() => expect(api.transferFiles).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.transferFiles).mock.calls[0][1]).toEqual([
      {
        local: "/local/file-local.txt",
        remote: "/remote/file-local.txt",
        upload: true,
        directory: false,
      },
    ]);

    // Remote → local: the download direction.
    await drag(remoteFile, localList);
    await vi.waitFor(() => expect(api.transferFiles).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.transferFiles).mock.calls[1][1]).toEqual([
      {
        local: "/local/file-remote.txt",
        remote: "/remote/file-remote.txt",
        upload: false,
        directory: false,
      },
    ]);
  });

  it("Escape cancels a drag and the drop never fires", async () => {
    await page.viewport(1100, 720);
    sftpPane();
    await twoFrames();

    const localFile = document.querySelector<HTMLElement>(
      '[data-file-path="/local/file-local.txt"]',
    )!;
    const remoteList = document.querySelectorAll<HTMLElement>(".ftp-browser-list")[0]!;
    const from = pagePoint(localFile);
    const to = pagePoint(remoteList);
    await mouse.press(from.x, from.y);
    await mouse.moveTo(from.x + 30, from.y + 10);
    await twoFrames();
    expect(
      document.querySelector(".ftp-dual-pane.is-dragging"),
      "the drag started (threshold passed)",
    ).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    await twoFrames();
    expect(
      document.querySelector(".ftp-dual-pane.is-dragging"),
      "Escape ended the drag",
    ).toBeNull();
    await mouse.moveTo(to.x, to.y);
    await mouse.release(to.x, to.y);
    await wait(150);
    expect(api.transferFiles).not.toHaveBeenCalled();
  });

  it("hiding the pane mid-drag stops the drop", async () => {
    await page.viewport(1100, 720);
    const mountedPane = sftpPane(true);
    await twoFrames();

    const localFile = document.querySelector<HTMLElement>(
      '[data-file-path="/local/file-local.txt"]',
    )!;
    const remoteList = document.querySelectorAll<HTMLElement>(".ftp-browser-list")[0]!;
    const from = pagePoint(localFile);
    await mouse.press(from.x, from.y);
    await mouse.moveTo(from.x + 30, from.y + 10);
    await twoFrames();
    expect(document.querySelector(".ftp-dual-pane.is-dragging")).not.toBeNull();

    // The tab switching away is the production hide: same pane, active=false.
    mountedPane.render(
      createElement(FtpPane, { tab: tabFor("responsive-sftp", "sftp"), active: false }),
    );
    await twoFrames();
    expect(
      document.querySelector(".ftp-dual-pane.is-dragging"),
      "the hide ended the drag",
    ).toBeNull();
    const to = pagePoint(remoteList);
    await mouse.moveTo(to.x, to.y);
    await mouse.release(to.x, to.y);
    await wait(150);
    expect(api.transferFiles).not.toHaveBeenCalled();
  });
});

describe("the resource monitor breakpoint at 1100px", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await browserAfterEach();
    await page.viewport(1100, 720);
  });

  it("above 1100px the wide summary shows; at and below it the compact one does", async () => {
    const displays = () => {
      const wide = document.querySelector<HTMLElement>(".resource-wide")!;
      const compact = document.querySelector<HTMLElement>(".resource-compact")!;
      return {
        wide: getComputedStyle(wide).display,
        compact: getComputedStyle(compact).display,
      };
    };

    await page.viewport(1101, 720);
    mount(createElement(ResourceMonitorBar, { tab: tabFor("responsive-ssh", "ssh") }));
    await twoFrames();
    expect(displays()).toEqual({ wide: "inline", compact: "none" });

    await page.viewport(1100, 720);
    await twoFrames();
    expect(displays()).toEqual({ wide: "none", compact: "inline" });

    await page.viewport(760, 600);
    await twoFrames();
    expect(displays()).toEqual({ wide: "none", compact: "inline" });
  });
});
