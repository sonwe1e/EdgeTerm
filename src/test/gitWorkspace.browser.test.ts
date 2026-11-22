import { createElement as h, type CSSProperties } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { GitAction, GitDiffTarget, GitStatus, GitTarget } from "../bindings";
import GitWorkspaceDialog from "../components/git/GitWorkspaceDialog";
import { gitDraftKey, writeGitDraft, type GitSource } from "../gitWorkspace";
import { IS_MAC } from "../platform";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (load) => ({
  ...(await load<typeof import("@tauri-apps/api/core")>()),
  invoke: ipc,
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

beforeEach(() => {
  status = baseline();
  stagedChunk = false;
  commitFails = false;
  useStore.getState().setLanguage("en");
  document.documentElement.setAttribute("data-theme", "dark");
  writeGitDraft(gitDraftKey(source, status), "");
  ipc.mockReset();
  ipc.mockImplementation(
    async (
      command: string,
      args: { target?: GitTarget; diff?: GitDiffTarget; action?: GitAction },
    ) => {
      if (command === "git_status") return structuredClone(status);
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
      if (command === "write_clipboard_text") return null;
      throw new Error(`Unexpected IPC command ${command}`);
    },
  );
});

afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial, true);
  useStore.getState().setLanguage(initial.language);
  document.documentElement.removeAttribute("data-theme");
});

const button = (name: string) => page.getByRole("button", { name, exact: true });
async function show(width = 1360, height = 820, panelFont = "13px") {
  await page.viewport(width, height);
  const props = { source, onClose: vi.fn() };
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
