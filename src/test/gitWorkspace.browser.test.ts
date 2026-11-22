import { createElement as h, type CSSProperties } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { GitAction, GitDiffTarget, GitStatus, GitTarget } from "../bindings";
import GitWorkspaceDialog from "../components/git/GitWorkspaceDialog";
import { LogViewerDialog } from "../components/LogViewerDialog";
import { lastPaths } from "../components/panels/filerDirectoryCache";
import { gitDraftKey, useGitSource, writeGitDraft, type GitSource } from "../gitWorkspace";
import { IS_MAC } from "../platform";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const ipc = vi.hoisted(() => vi.fn());
const dialogOpen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (load) => ({
  ...(await load<typeof import("@tauri-apps/api/core")>()),
  invoke: ipc,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpen,
  save: vi.fn(),
  ask: vi.fn(),
}));

const root = "/srv/team/forecast-engine";
const source: GitSource = {
  sessionId: "ssh-fixture",
  directory: `${root}/src`,
  label: "Lab SSH · gpu-03",
};
const target: GitTarget = { sessionId: source.sessionId, directory: root };
const path = "src/training/forecast.ts";
const longPath = "experiments/temperature/validation/2026/气温数据模型和观测对照.settings.json";
const oid = "c9e4c47" + "0".repeat(33);
const initial = useStore.getState();
const baseline = (): GitStatus => ({
  root,
  branch: "feature/forecast-calibration",
  head: oid,
  upstream: "origin/feature/forecast-calibration",
  ahead: 2,
  behind: 0,
  commitToken: "snapshot-1",
  changes: [
    { path, originalPath: null, staged: "modified", working: "modified", conflicted: false },
    {
      path: "docs/calibration.md",
      originalPath: null,
      staged: "added",
      working: null,
      conflicted: false,
    },
    {
      path: "config/model.yaml",
      originalPath: null,
      staged: null,
      working: "modified",
      conflicted: false,
    },
    { path: longPath, originalPath: null, staged: null, working: "untracked", conflicted: false },
  ],
});

const fileHeader = (name: string) =>
  `diff --git a/${name} b/${name}\nindex 1234567..abcdef0 100644\n--- a/${name}\n+++ b/${name}\n`;
const firstHunk = [
  "@@ -18,7 +18,8 @@ export function train(config: TrainingConfig) {",
  "   const dataset = loadDataset(config.source);",
  "   const steps = config.totalSteps;",
  "-  const warmupSteps = 100;",
  "+  const warmupSteps = Math.min(500, Math.floor(steps * 0.05));",
  "+  const gradientClip = config.gradientClip ?? 1.0;",
  "   const optimizer = createOptimizer({ warmupSteps });",
  "   const schedule = cosineDecay(steps);",
  "   const checkpoint = config.checkpointDirectory;",
  "",
].join("\n");
const secondHunk = [
  "@@ -64,6 +65,7 @@ export function train(config: TrainingConfig) {",
  "   const forecast = evaluate(model, validationData);",
  "   const metrics = collectMetrics(forecast);",
  "   await writeMetrics(metrics, checkpoint);",
  "+  await writeCalibrationCurve(forecast, checkpoint);",
  "   return { metrics, checkpoint };",
  " }",
  "",
].join("\n");
const stagedHunk =
  '@@ -4,3 +4,4 @@\n export const loss = "huber";\n+export const seed = 105;\n \n function normalize() {\n';

let status: GitStatus;
let stagedChunk: boolean;
let commitFails: boolean;
let invalidFolder: string | null = null;

beforeEach(() => {
  status = baseline();
  stagedChunk = false;
  commitFails = false;
  invalidFolder = null;
  useStore.getState().setLanguage("en");
  document.documentElement.setAttribute("data-theme", "dark");
  writeGitDraft(gitDraftKey(source, status), "");
  useGitSource.setState({ source: null });
  lastPaths.clear();
  dialogOpen.mockReset();
  dialogOpen.mockResolvedValue(null);
  ipc.mockReset();
  ipc.mockImplementation(
    async (
      command: string,
      args: {
        target?: GitTarget;
        diff?: GitDiffTarget;
        action?: GitAction;
        id?: string | null;
        path?: string;
        anchor?: number | null;
        before?: boolean;
        encoding?: string | null;
      },
    ) => {
      if (command === "git_status") {
        if (invalidFolder && args.target?.directory === invalidFolder) return null;
        return structuredClone(status);
      }
      if (command === "git_diff") {
        if (args.diff?.kind === "commit")
          return { kind: "text", text: fileHeader(path) + stagedHunk, token: null };
        const file = args.diff?.file;
        if (file?.path === path && file.scope === "staged") {
          return {
            kind: "text",
            text: fileHeader(path) + stagedHunk + (stagedChunk ? firstHunk : ""),
            token: "index-patch",
          };
        }
        if (file?.path === longPath)
          return {
            kind: "text",
            text:
              fileHeader(longPath) +
              `@@ -1 +1 @@\n-old\n+${"观测_LONG_UNBROKEN".repeat(80)}END_OF_LINE\n`,
            token: null,
          };
        return {
          kind: "text",
          text: fileHeader(path) + (stagedChunk ? "" : firstHunk) + secondHunk,
          token: stagedChunk ? "working-revised" : "working-patch",
        };
      }
      if (command === "git_history")
        return [
          {
            oid,
            shortOid: oid.slice(0, 7),
            subject: "Calibrate confidence intervals",
            author: "Fixture author",
            date: "2026-11-18T18:00:00+08:00",
          },
        ];
      if (command === "git_branches") return ["main", "feature/forecast-calibration"];
      if (command === "git_mutate") {
        const action = args.action;
        if (action?.kind === "hunk") {
          stagedChunk = action.scope === "working";
          status.commitToken = "snapshot-2";
        }
        if (action?.kind === "commit") {
          if (commitFails) {
            commitFails = false;
            status.commitToken = "snapshot-external-change";
            throw { code: "conflict", message: "index changed" };
          }
          status.changes = status.changes
            .filter((change) => change.working)
            .map((change) => ({ ...change, staged: null }));
        }
        if (action?.kind === "switch" || action?.kind === "createBranch")
          status.branch = action.branch;
        return null;
      }
      if (command === "project_read_log_window")
        return {
          path: args.path ?? "/srv/logs/build.log",
          start: 0,
          end: 30,
          size: 30,
          content: "build started\nbuild complete\n",
          encoding: "UTF-8",
          modifiedAt: 0,
        };
      if (command === "write_clipboard_text") return null;
      throw new Error(`Unexpected IPC command ${command}`);
    },
  );
});

afterEach(async () => {
  await browserAfterEach();
  useGitSource.setState({ source: null });
  lastPaths.clear();
  useStore.setState(initial, true);
  useStore.getState().setLanguage(initial.language);
  document.documentElement.removeAttribute("data-theme");
});

const button = (name: string) => page.getByRole("button", { name, exact: true });
const folderButton = () => button("Open another folder…");
async function openFolderMenu() {
  await userEvent.click(folderButton());
  await expect.element(page.getByRole("menu", { name: "Open another folder…" })).toBeVisible();
}
async function show(
  width = 1360,
  height = 820,
  panelFont = "13px",
  mountSource: GitSource = source,
) {
  await page.viewport(width, height);
  const props = { source: mountSource, onClose: vi.fn() };
  const mounted = mount(
    h(
      "div",
      {
        className: "app",
        style: { "--panel-font-size": panelFont } as CSSProperties,
      },
      h(GitWorkspaceDialog, props),
    ),
  );
  await expect.element(button("Stage hunk 1")).toBeEnabled();
  return { mounted, props };
}

it("keeps the same file in review while staging hunks and commits the refreshed index only", async () => {
  await show();
  await expect.element(page.getByText("2 staged · 3 unstaged", { exact: true })).toBeVisible();
  await expect.element(button("Next difference")).toBeEnabled();
  await userEvent.click(button("Next difference"));
  await expect.element(page.getByText("Hunk 2 of 2", { exact: true })).toBeVisible();
  await userEvent.click(button("Stage hunk 1"));
  await expect.element(page.getByText("Hunk 1 of 1", { exact: true })).toBeVisible();
  expect(ipc).toHaveBeenCalledWith("git_mutate", {
    target,
    action: { kind: "hunk", path, scope: "working", index: 0, token: "working-patch" },
  });
  expect(document.querySelector(".git-patch")?.textContent).toContain("writeCalibrationCurve");
  expect(document.querySelector(".git-patch")?.textContent).not.toContain("gradientClip");
  await userEvent.click(button("Staged"));
  await expect.element(button("Unstage hunk 2")).toBeEnabled();
  expect(document.querySelector(".git-patch")?.textContent).toContain("gradientClip");
  await userEvent.click(button("Unstage hunk 2"));
  expect(ipc).toHaveBeenCalledWith("git_mutate", {
    target,
    action: { kind: "hunk", path, scope: "staged", index: 1, token: "index-patch" },
  });
  await expect.element(button("Unstage hunk 1")).toBeEnabled();

  const message = page.getByRole("textbox", { name: "Commit message" });
  await userEvent.fill(message, "Calibrate staged defaults");
  commitFails = true;
  await userEvent.click(button("Commit staged"));
  await expect.element(page.getByRole("alert")).toHaveTextContent("Review the refreshed changes");
  await expect.element(message).toHaveValue("Calibrate staged defaults");
  await expect.element(button("Commit staged")).toBeEnabled();
  await userEvent.click(message);
  const mod = IS_MAC ? "Meta" : "Control";
  await userEvent.keyboard(`{${mod}>}{Enter}{/${mod}}`);
  await expect.element(page.getByText("Commit created", { exact: true })).toBeVisible();
  await expect.element(message).toHaveValue("");
  await expect.element(page.getByText("0 staged · 3 unstaged", { exact: true })).toBeVisible();
  expect(ipc).toHaveBeenCalledWith("git_mutate", {
    target,
    action: {
      kind: "commit",
      message: "Calibrate staged defaults",
      token: "snapshot-external-change",
    },
  });
});

it("browses and copies a commit and switches branches in the original SSH worktree", async () => {
  await show(900, 560);
  await userEvent.click(button("History"));
  await expect
    .element(page.getByRole("button", { name: /Calibrate confidence intervals/ }))
    .toBeVisible();
  await expect.element(button("Copy commit ID")).toBeVisible();
  await userEvent.click(button("Copy commit ID"));
  expect(ipc).toHaveBeenCalledWith("git_diff", { target, diff: { kind: "commit", oid } });
  expect(ipc).toHaveBeenCalledWith("write_clipboard_text", { text: oid });
  await expect.element(page.getByText("Commit ID copied", { exact: true })).toBeVisible();
  await userEvent.click(button("feature/forecast-calibration"));
  await expect
    .element(page.getByRole("dialog", { name: "Switch or create a branch" }))
    .toBeVisible();
  await userEvent.click(button("main"));
  await userEvent.click(button("Switch branch"));
  await expect
    .element(page.getByRole("dialog", { name: "Switch or create a branch" }))
    .not.toBeInTheDocument();
  await expect.element(button("main")).toBeEnabled();
  expect(ipc).toHaveBeenCalledWith("git_mutate", {
    target,
    action: { kind: "switch", branch: "main", token: "snapshot-1" },
  });
});

it("keeps review controls visible across the desktop minimum and both layout boundaries", async () => {
  await show();
  await expect
    .poll(
      () =>
        Array.from(document.querySelectorAll<HTMLImageElement>(".git-file-icon img")).filter(
          (image) => image.complete && image.naturalWidth > 0,
        ).length,
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: "../../artifacts/git-workspace/review-dark.png" });
  await userEvent.click(button("Side by side"));
  await expect.element(page.getByText("Before", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../../artifacts/git-workspace/review-split.png" });
  const filter = page.getByRole("searchbox", { name: "Filter changed files" });
  const mod = IS_MAC ? "Meta" : "Control";
  await userEvent.keyboard(`{${mod}>}f{/${mod}}`);
  expect(document.activeElement).toBe(filter.element());
  await userEvent.fill(filter, "气温数据");
  await expect
    .poll(() => document.querySelector(".git-patch")?.textContent)
    .toContain("END_OF_LINE");
  for (const width of [900, 761, 760, 759, 481, 480, 479]) {
    await page.viewport(width, width === 900 ? 560 : 700);
    await twoFrames();
    const container = document.querySelector<HTMLElement>(".git-workspace")!;
    const patch = document.querySelector<HTMLElement>(".git-patch")!;
    expect(container.scrollWidth, `workspace at ${width}px`).toBeLessThanOrEqual(
      container.clientWidth + 1,
    );
    expect(patch.scrollWidth, `changed content at ${width}px`).toBeLessThanOrEqual(
      patch.clientWidth + 1,
    );
    for (const control of container.querySelectorAll(
      ".git-workspace-actions button, .git-composer .btn, .git-split-toggle",
    )) {
      const bounds = control.getBoundingClientRect();
      expect(bounds.left, `${control.textContent} at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    }
  }
  await page.viewport(900, 560);
  await userEvent.fill(filter, "");
  useStore.getState().setLanguage("zh-CN");
  document.documentElement.setAttribute("data-theme", "light");
  await expect.element(button("提交暂存内容")).toBeVisible();
  await page.screenshot({ path: "../../artifacts/git-workspace/review-light-zh.png" });
});

// ---- geometry and typography contracts -------------------------------------

function elementOf(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

function fontOf(selector: string): { size: string; family: string } {
  const style = getComputedStyle(elementOf(selector));
  return {
    size: style.fontSize,
    family: style.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
  };
}

function rectOf(selector: string): { width: number; height: number } {
  const box = elementOf(selector).getBoundingClientRect();
  return { width: box.width, height: box.height };
}

function gitType() {
  return {
    title: fontOf(".git-location h2"),
    reviewTitle: fontOf(".git-review-title h3"),
    groupHeading: fontOf(".git-change-group-head h3"),
    fileRow: fontOf(".git-file-select"),
    branchButton: fontOf(".git-branch-button"),
    stageButton: fontOf(".git-review-actions .btn"),
    textButton: fontOf(".git-review-actions .git-text-button"),
    commitTextarea: fontOf(".git-composer textarea"),
    patchRow: fontOf(".git-unified-row"),
  };
}

async function showLogViewer(panelFont: string) {
  const mounted = mount(
    h(
      "div",
      { className: "app", style: { "--panel-font-size": panelFont } as CSSProperties },
      h(LogViewerDialog, {
        target: {
          sessionId: source.sessionId,
          path: "/srv/logs/build.log",
          name: "build.log",
          sourceTabId: source.sessionId ?? "local",
        },
        onClose: vi.fn(),
      }),
    ),
  );
  await expect
    .poll(() => document.querySelector(".log-viewer-text")?.textContent)
    .toContain("build complete");
  await twoFrames();
  return mounted;
}

/**
 * The dialog is a workspace: it claims the viewport up to a 1760x1100 desktop
 * surface, and keeps 16px gutters below those caps. Literal numbers: they pin
 * the contract, they are not read back from the stylesheet.
 */
it("sizes the workspace to the viewport up to a 1760x1100 desktop cap", async () => {
  await show(1360, 820);
  const cases = [
    { width: 1360, height: 820, dialogWidth: 1328, dialogHeight: 788 },
    { width: 1920, height: 1080, dialogWidth: 1760, dialogHeight: 1048 },
    { width: 2560, height: 1440, dialogWidth: 1760, dialogHeight: 1100 },
    { width: 900, height: 560, dialogWidth: 868, dialogHeight: 528 },
  ];
  for (const { width, height, dialogWidth, dialogHeight } of cases) {
    await page.viewport(width, height);
    await twoFrames();
    const box = rectOf(".git-workspace");
    expect(box.width, `width at ${width}x${height}`).toBeCloseTo(dialogWidth, 0);
    expect(box.height, `height at ${width}x${height}`).toBeCloseTo(dialogHeight, 0);
  }
  await page.viewport(1920, 1080);
  await twoFrames();
  expect(rectOf(".git-workspace").width).toBeGreaterThanOrEqual(1920 * 0.9);
});

/**
 * The title follows the documented dialog-title convention (fs-md, the rung
 * .dialog-header uses), not a private offset. The comparable LogViewerDialog
 * is mounted through the same .app wrapper and measured at the same panel
 * fonts; the two headers must agree at both.
 */
it("takes its title from the shared dialog-title rung at 12px and 15px panel fonts", async () => {
  for (const [panelFont, expected] of [
    ["12px", "14px"],
    ["15px", "17px"],
  ] as const) {
    const viewer = await showLogViewer(panelFont);
    const dialogTitle = fontOf(".log-viewer-dialog .dialog-header");
    viewer.render(null);
    const { mounted } = await show(1360, 820, panelFont);
    const title = fontOf(".git-location h2");
    expect(dialogTitle.size, `dialog header at ${panelFont}`).toBe(expected);
    expect(title.size, `git title at ${panelFont}`).toBe(dialogTitle.size);
    mounted.render(null);
  }
});

/**
 * Every chrome role sits on a --fs rung and grows with the panel font. The
 * scan rejects any UI-family size that is not a rung; mono surfaces (paths,
 * diff code) are excluded there but the selected-file path and the patch are
 * asserted explicitly. Literal rungs come from the documented ladder:
 * 12px -> 9/10/11/12/14, 15px -> 12/13/14/15/17.
 */
it("keeps chrome type on the --fs ladder and scales it with the panel font", async () => {
  const { mounted } = await show(1360, 820, "12px");
  const at12 = gitType();
  const expected12 = {
    title: "14px",
    reviewTitle: "12px",
    groupHeading: "12px",
    fileRow: "12px",
    branchButton: "12px",
    stageButton: "12px",
    textButton: "11px",
    commitTextarea: "12px",
    patchRow: "13px",
  };
  for (const [role, expected] of Object.entries(expected12)) {
    expect(at12[role as keyof typeof at12].size, role).toBe(expected);
  }
  // A header control is UI type; the selected file path is the mono surface.
  expect(at12.branchButton.family).toBe(at12.title.family);
  expect(at12.branchButton.family).not.toBe(at12.reviewTitle.family);

  const expectOnlyLadderSizes = (ladder: string[]) => {
    const mono = at12.reviewTitle.family;
    for (const element of elementOf(".git-workspace").querySelectorAll<HTMLElement>("*")) {
      if (element instanceof SVGElement || element.classList.contains("icon")) continue;
      const style = getComputedStyle(element);
      const family = style.fontFamily;
      if (family.includes("monospace") || family.split(",")[0].replace(/["']/g, "").trim() === mono)
        continue;
      expect(ladder, `${element.tagName.toLowerCase()} ${element.className}`).toContain(
        style.fontSize,
      );
    }
  };
  expectOnlyLadderSizes(["9px", "10px", "11px", "12px", "14px"]);

  mounted.container
    .querySelector<HTMLElement>(".app")!
    .style.setProperty("--panel-font-size", "15px");
  await twoFrames();
  const at15 = gitType();
  const expected15 = {
    title: "17px",
    reviewTitle: "15px",
    groupHeading: "15px",
    fileRow: "15px",
    branchButton: "15px",
    stageButton: "15px",
    textButton: "14px",
    commitTextarea: "15px",
    patchRow: "15px",
  };
  for (const [role, expected] of Object.entries(expected15)) {
    expect(at15[role as keyof typeof at15].size, role).toBe(expected);
  }
  expectOnlyLadderSizes(["12px", "13px", "14px", "15px", "17px"]);
});

it("switches the SSH dialog to a folder typed for the same server", async () => {
  await show();
  await openFolderMenu();
  await userEvent.click(
    page.getByRole("menuitem", { name: "Another folder on this server…", exact: true }),
  );
  const field = page.getByRole("textbox", { name: "Folder path on the server" });
  await expect.element(field).toBeVisible();
  await userEvent.fill(field, "/srv/team/other-repo");
  await userEvent.keyboard("{Enter}");
  expect(ipc).toHaveBeenCalledWith("git_status", {
    target: { sessionId: "ssh-fixture", directory: "/srv/team/other-repo" },
  });
  await expect
    .poll(() => useGitSource.getState().source)
    .toEqual({
      directory: "/srv/team/other-repo",
      sessionId: "ssh-fixture",
      label: "Lab SSH · gpu-03",
    });
});

it("keeps the dialog open and reports a folder outside a worktree on the server", async () => {
  invalidFolder = "/srv/team/not-a-repo";
  await show();
  await openFolderMenu();
  await userEvent.click(
    page.getByRole("menuitem", { name: "Another folder on this server…", exact: true }),
  );
  const field = page.getByRole("textbox", { name: "Folder path on the server" });
  await userEvent.fill(field, invalidFolder);
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toHaveTextContent("outside a Git worktree");
  await expect.element(field).toBeVisible();
  await expect.element(button("Stage hunk 1")).toBeEnabled();
  expect(useGitSource.getState().source).toBeNull();
});

it("offers the Files panel folder for this session and never another session's", async () => {
  lastPaths.set("ssh-fixture", "/srv/team/shared");
  lastPaths.set("another-session", "/srv/team/other");
  await show();
  await openFolderMenu();
  await expect
    .element(page.getByRole("menuitem", { name: "Files panel folder", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("menuitem", { name: "/srv/team/other", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("menuitem", { name: "Files panel folder", exact: true }));
  await expect
    .poll(() => useGitSource.getState().source)
    .toEqual({
      directory: "/srv/team/shared",
      sessionId: "ssh-fixture",
      label: "Lab SSH · gpu-03",
    });
});

it("offers the local picker to a local source and opens the chosen folder locally", async () => {
  status.root = "/home/me/project";
  const localSource: GitSource = {
    sessionId: null,
    directory: "/home/me/project",
    label: null,
  };
  dialogOpen.mockResolvedValue("C:\\work\\edge");
  await show(1360, 820, "13px", localSource);
  await openFolderMenu();
  await expect
    .element(page.getByRole("menuitem", { name: "Another folder on this server…", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("menuitem", { name: "Another local folder…", exact: true }));
  expect(dialogOpen).toHaveBeenCalledWith({
    title: "Open local folder…",
    directory: true,
    multiple: false,
    defaultPath: "/home/me/project",
  });
  await expect
    .poll(() => useGitSource.getState().source)
    .toEqual({
      directory: "C:\\work\\edge",
      sessionId: null,
      label: null,
    });
});

it("opens the source menu from the keyboard and returns focus on Escape", async () => {
  await show();
  const trigger = folderButton();
  trigger.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .poll(() => document.activeElement?.textContent)
    .toContain("Another folder on this server");
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toContain("Another local folder");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("menuitem", { name: "Another local folder…", exact: true }))
    .not.toBeInTheDocument();
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});
