import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../styles.css";
import { setCurrentLanguage } from "../i18n";
import { useStore } from "../store";
import { browserAfterEach, mount, wait } from "../test/browserHarness";
import * as wb from "./api";
import { connectedTabFor, ensureSessionFor } from "./session";
import { useWorkbench } from "./store";
import { Workbench } from "./Workbench";
import type { Tab } from "../store";
import type { WorkspaceData } from "./types";

vi.mock("./api", () => ({
  loadData: vi.fn(),
  saveWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  saveExperiment: vi.fn(),
  deleteExperiment: vi.fn(),
  recordRun: vi.fn(),
  updateRun: vi.fn(),
  deleteRun: vi.fn(),
  probe: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
  statFile: vi.fn(),
  listFiles: vi.fn(),
  search: vi.fn(),
  gitState: vi.fn(),
  gitDiff: vi.fn(),
  readLog: vi.fn(),
  startRun: vi.fn(),
  runStatus: vi.fn(),
  stopRun: vi.fn(),
  compare: vi.fn(),
}));

vi.mock("./session", () => ({
  connectedTabFor: vi.fn(),
  ensureSessionFor: vi.fn(),
  openWorkspaceTerminal: vi.fn(),
  shellQuote: (value: string) => `'${value}'`,
}));

// One stored unsaved buffer, so the recovery list has something to show and
// the header count is not zero.
vi.mock("./drafts", async () => {
  const actual = await vi.importActual<typeof import("./drafts")>("./drafts");
  const seeded = [
    {
      docId: "w1::/data/vfi/baseline/src/loss.py",
      workspaceId: "w1",
      serverKey: "lab@gpu-01:22",
      serverLabel: "gpu-01",
      projectName: "vfi-baseline",
      path: "src/loss.py",
      absolutePath: "/data/vfi/baseline/src/loss.py",
      content: "def loss(pred, target):\n    return 0.0\n",
      baseHash: "h1",
      updatedAt: Date.now() - 60_000,
    },
  ];
  return {
    ...actual,
    ensureDraftsLoaded: async () => undefined,
    importLegacyDrafts: async () => 0,
    reloadDrafts: async () => ({ ok: true, error: null }),
    cachedDrafts: () => seeded,
    cachedDraft: (id: string) => seeded.find((draft) => draft.docId === id) ?? null,
    draftBytes: () => seeded[0].content.length,
    draftDirectory: () => "C:\\Users\\lab\\AppData\\Roaming\\EdgeTerm\\drafts",
    draftUnreadable: () => 0,
    draftLoadError: () => null,
    saveDraft: async () => ({ ok: true, error: null }),
    removeDraft: async () => ({ ok: true, error: null }),
  };
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  sampleResources: vi.fn().mockResolvedValue({
    status: "ok",
    cpuPercent: 37.5,
    cpuStatus: "ok",
    memory: { usedBytes: 12 * 1024 ** 3, totalBytes: 64 * 1024 ** 3 },
    memoryStatus: "ok",
    capacity: { usedBytes: 220 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3, mount: "/" },
    capacityStatus: "ok",
    diskReadBps: 1024,
    diskWriteBps: 2048,
    diskStatus: "ok",
    networkReceiveBps: 1024 * 1024,
    networkSendBps: 2048,
    networkStatus: "ok",
    gpus: [
      {
        index: 0,
        name: "NVIDIA A100",
        utilization: 82,
        usedBytes: 30 * 1024 ** 3,
        totalBytes: 40 * 1024 ** 3,
        temperature: 61,
      },
    ],
    gpuStatus: "ok",
  }),
}));

const server = (host: string, profileId: string) => ({
  profileId,
  name: host,
  host,
  port: 22,
  username: "lab",
});

const DATA: WorkspaceData = {
  workspaces: [
    {
      id: "w1",
      name: "vfi-baseline",
      server: server("gpu-01", "p1"),
      root: "/data/vfi/baseline",
      env: "conda activate vfi",
      commands: [
        {
          id: "c1",
          label: "train baseline",
          command: "python train.py -c configs/base.yaml",
          kind: "train",
        },
      ],
      runRoot: "",
      baselineExperimentId: "e1",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "w2",
      name: "vfi-ablation-a",
      server: server("gpu-01", "p1"),
      root: "/data/vfi/ablation_a",
      env: "conda activate vfi",
      commands: [],
      runRoot: "",
      baselineExperimentId: "e2",
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: "w3",
      name: "vfi-ablation-b",
      server: server("gpu-02", "p2"),
      root: "/mnt/fast/ablation_b",
      env: "",
      commands: [],
      runRoot: "",
      baselineExperimentId: "e3",
      createdAt: 3,
      updatedAt: 3,
    },
  ],
  experiments: [
    {
      id: "e1",
      workspaceId: "w1",
      name: "baseline",
      kind: "baseline",
      baselineId: null,
      root: null,
      branch: "main",
      notes: "",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "e2",
      workspaceId: "w2",
      name: "ablation A",
      kind: "variant",
      baselineId: "e1",
      root: null,
      branch: null,
      notes: "",
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: "e3",
      workspaceId: "w3",
      name: "ablation B",
      kind: "baseline",
      baselineId: null,
      root: null,
      branch: null,
      notes: "",
      createdAt: 3,
      updatedAt: 3,
    },
  ],
  runs: [
    {
      id: "r1",
      workspaceId: "w1",
      experimentId: "e1",
      server: server("gpu-01", "p1"),
      root: "/data/vfi/baseline",
      command: "python train.py -c configs/base.yaml",
      env: "conda activate vfi",
      gpu: "0",
      scheduler: null,
      submitOnly: false,
      mode: "tmux",
      status: "running",
      startedAt: Date.now() - 1000 * 60 * 42,
      endedAt: null,
      exitCode: null,
      code: {
        branch: "main",
        commit: "9b904b4a12234567890",
        dirty: true,
        dirtyFiles: ["models/rife.py"],
        diffSha256: "abc123",
        diffBytes: 500,
        diffTruncated: false,
        isRepository: true,
      },
      snapshot: {
        mode: "code",
        path: "/data/vfi/baseline/.edgeterm/runs/r1/code",
        files: 42,
        bytes: 1024 * 1024,
        skipped: 3,
        verified: true,
        note: "",
      },
      binding: {
        execution: "workspace",
        executedFrom: "/data/vfi/baseline",
        workspaceRoot: "/data/vfi/baseline",
        isolated: false,
        snapshotVerified: true,
        unsynced: [],
        links: [],
        note: "",
      },
      runDir: "/data/vfi/baseline/.edgeterm/runs/r1",
      logPath: "/data/vfi/baseline/.edgeterm/runs/r1/run.log",
      taskName: "et-r1",
      resumedFrom: null,
      note: "",
      lastSeenAt: Date.now(),
    },
  ],
};

const PYTHON = `import torch
from models.rife import IFNet

def train(config):
    model = IFNet(scale=config["scale"])
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
    for step, batch in enumerate(loader):
        pred = model(batch["frame0"], batch["frame1"])
        loss = criterion(pred, batch["middle"])
        loss.backward()
        optimizer.step()
    return model
`;

const tab = (): Tab =>
  ({
    info: {
      id: "s1",
      profileId: "p1",
      name: "gpu-01",
      kind: "ssh",
      protocol: "ssh",
      address: "gpu-01:22",
      color: null,
      supportsRemoteFiles: true,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id: "p1", name: "gpu-01", kind: "ssh" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: "root",
  }) as unknown as Tab;

describe("workbench layout", () => {
  afterEach(() => {
    browserAfterEach();
  });

  it("shows server and project identity, an editor and a live run", async () => {
    localStorage.clear();
    useStore.setState({ theme: "light", bufferFontSize: 13, panelFontSize: 12 });
    // App applies this before rendering; mounting the workbench alone must
    // set the same root attribute or the CSS variables stay in the dark set.
    document.documentElement.dataset.theme = "light";
    vi.mocked(wb.loadData).mockResolvedValue(structuredClone(DATA));
    vi.mocked(wb.listFiles).mockResolvedValue({
      root: "/data/vfi/baseline",
      files: [
        "configs/base.yaml",
        "models/rife.py",
        "scripts/train.sh",
        "src/dataset.py",
        "src/train.py",
      ],
      truncated: false,
      source: "git",
    });
    vi.mocked(wb.gitState).mockResolvedValue({
      isRepository: true,
      branch: "main",
      commit: "9b904b4",
      dirty: true,
      files: [{ path: "models/rife.py", status: "M" }],
      diffSha256: "abc",
      diffBytes: 500,
      diffTruncated: false,
      note: "",
    });
    vi.mocked(wb.readText).mockImplementation(async (_session, path) => ({
      path,
      content: PYTHON,
      hash: "h1",
      size: PYTHON.length,
      encoding: "UTF-8",
      eol: "lf",
      bom: false,
      modifiedAt: Date.now(),
      permissions: 0o644,
    }));
    vi.mocked(wb.runStatus).mockResolvedValue({
      status: "running",
      exitCode: null,
      alive: true,
      logSize: 80,
      checkedAt: Date.now(),
      note: "",
    });
    vi.mocked(wb.readLog).mockResolvedValue({
      path: "/data/vfi/baseline/.edgeterm/runs/r1/run.log",
      content:
        "[epoch 12] loss=0.0182 psnr=31.4\n[epoch 12] saved checkpoint step_12000.pth\n" +
        'Traceback (most recent call last):\n  File "train.py", line 6, in train\n' +
        '    loss = criterion(pred, batch["middle"])\nRuntimeError: CUDA error\n',
      offset: 80,
      size: 80,
      reset: true,
      exists: true,
    });
    vi.mocked(wb.probe).mockResolvedValue({
      os: "Linux 5.15",
      home: "/home/lab",
      shell: "/bin/bash",
      git: true,
      tmux: true,
      python: "/usr/bin/python3",
      conda: true,
      nvidiaSmi: true,
      scheduler: "slurm",
      isRepository: true,
      rootExists: true,
      paths: [],
    });
    vi.mocked(connectedTabFor).mockReturnValue(tab());
    vi.mocked(ensureSessionFor).mockResolvedValue("s1");

    await useWorkbench.getState().init();
    await useWorkbench.getState().refreshFiles("w1");
    await useWorkbench.getState().refreshGit("w1");
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");

    await page.viewport(1440, 900);
    const surface = mount(createElement(Workbench));

    // The editor bundle is a dynamic import; wait for the real CodeMirror
    // surface rather than a fixed delay.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (document.querySelector(".cm-content")) break;
      await wait(100);
    }
    expect(document.querySelector(".cm-content")).not.toBeNull();
    await wait(300);

    // A traceback frame in the log opens that remote file; the line target is
    // verified by the store/logJump unit tests, this proves the click path.
    const logLinks = document.querySelectorAll<HTMLButtonElement>(".wb-log-link");
    expect(logLinks.length).toBe(1);
    await userEvent.click(logLinks[0]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (vi.mocked(wb.readText).mock.calls.some(([, path]) => path.includes("train.py"))) {
        break;
      }
      await wait(100);
    }
    const jumpId = "w1::/data/vfi/baseline/train.py";
    const jumped = useWorkbench.getState().docs.find((doc) => doc.id === jumpId);
    expect(jumped).toBeDefined();
    expect(vi.mocked(wb.readText)).toHaveBeenCalledWith("s1", "/data/vfi/baseline/train.py");
    expect(useWorkbench.getState().activeDocId).toBe(jumpId);
    await wait(300);

    // Leave the original single-document state for the assertions below.
    await useWorkbench.getState().closeDoc(jumpId);
    expect(useWorkbench.getState().docs).toHaveLength(1);

    const body = document.body;
    expect(body.textContent).toContain("vfi-baseline");
    expect(body.textContent).toContain("lab@gpu-01:22");
    expect(body.textContent).toContain("src/train.py");
    expect(document.querySelector(".wb-status-pill.is-running")).not.toBeNull();
    // The recovery entry point and the executed-content block are part of the
    // layout the screenshot is evidence for.
    const headerButtons = [...document.querySelectorAll(".wb-top-actions button")].map(
      (button) => button.textContent ?? "",
    );
    expect(headerButtons.some((text) => text.includes("草稿"))).toBe(true);
    expect(body.textContent).toContain("执行内容");
    expect(body.textContent).toContain("执行目录");
    expect(body.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);

    await page.screenshot({ path: "../../artifacts/workbench-light.png" });

    // Compact mode exposes files immediately and retains the mounted editor.
    await page.viewport(900, 560);
    // Leave the same room as the normal 220px/300px side docks.
    surface.container.style.width = "380px";
    document.documentElement.style.setProperty("--panel-font-size", "18px");
    await userEvent.click(page.getByRole("button", { name: "项目文件", exact: true }));
    const explorer = document.querySelector<HTMLElement>(".wb-explorer")!;
    expect(explorer.getBoundingClientRect().height).toBeGreaterThan(50);
    expect(explorer.getBoundingClientRect().bottom).toBeLessThanOrEqual(560);
    const workbench = document.querySelector<HTMLElement>(".wb")!;
    expect(workbench.scrollWidth).toBeLessThanOrEqual(workbench.clientWidth + 1);
    const stop = document.querySelector<HTMLElement>(".wb-console .is-danger")!;
    expect(getComputedStyle(stop).color).not.toBe(getComputedStyle(stop).backgroundColor);
    expect(document.querySelector<HTMLElement>(".wb-center")!.getBoundingClientRect().height).toBe(
      0,
    );
    await page.screenshot({ path: "../../artifacts/usability/workbench-files-900.png" });
    await userEvent.click(page.getByRole("button", { name: "编辑器", exact: true }));
    expect(document.querySelector(".cm-content")).not.toBeNull();
    expect(useWorkbench.getState().docs).toHaveLength(1);
    // At this width the title and actions fit on one row. Keeping them
    // together gives the editor space without removing any controls.
    const title = document.querySelector<HTMLElement>(".wb-top-title")!.getBoundingClientRect();
    const actions = document.querySelector<HTMLElement>(".wb-top-actions")!.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".wb-top")!.getBoundingClientRect();
    expect(
      Math.abs((title.top + title.bottom) / 2 - (actions.top + actions.bottom) / 2),
    ).toBeLessThan(1);
    expect(actions.left).toBeGreaterThanOrEqual(title.right);
    expect(actions.right).toBeLessThanOrEqual(header.right);
    await page.screenshot({ path: "../../artifacts/usability/workbench-editor-900.png" });

    // Longer English labels need room of their own; squeezing them into
    // equal thirds used three lines and took usable height from the editor.
    const language = useStore.getState().language;
    try {
      setCurrentLanguage("en");
      useStore.setState({ language: "en" });
      await wait(100);
      const navButtons = [...document.querySelectorAll<HTMLElement>(".wb-compact-nav button")];
      const projectLabel = document.createRange();
      projectLabel.selectNodeContents(navButtons[0]);
      expect(
        [...projectLabel.getClientRects()].filter((rect) => rect.width > 0).length,
      ).toBeLessThanOrEqual(2);
      for (const width of [380, 320]) {
        surface.container.style.width = `${width}px`;
        await wait(100);
        for (const button of navButtons) {
          const range = document.createRange();
          range.selectNodeContents(button);
          const text = range.getBoundingClientRect();
          const box = button.getBoundingClientRect();
          expect(text.left).toBeGreaterThanOrEqual(box.left - 0.5);
          expect(text.right).toBeLessThanOrEqual(box.right + 0.5);
        }
        const breadcrumb = document.querySelector<HTMLElement>(".wb-breadcrumb")!;
        const breadcrumbBox = breadcrumb.getBoundingClientRect();
        const editorActions = document
          .querySelector<HTMLElement>(".wb-editor-actions")!
          .getBoundingClientRect();
        expect(breadcrumbBox.width).toBeGreaterThan(width * 0.8);
        expect(breadcrumbBox.bottom).toBeLessThanOrEqual(editorActions.top + 0.5);
        for (const child of breadcrumb.children) {
          expect(child.getBoundingClientRect().right).toBeLessThanOrEqual(
            breadcrumbBox.right + 0.5,
          );
        }
        if (width === 320) {
          // The run's header must leave room for at least its first log line.
          const log = document.querySelector<HTMLElement>(".wb-log-view")!;
          const logStyle = getComputedStyle(log);
          const firstLineBottom =
            log.getBoundingClientRect().top +
            parseFloat(logStyle.paddingTop) +
            parseFloat(logStyle.lineHeight);
          const consoleBottom = document
            .querySelector<HTMLElement>(".wb-console")!
            .getBoundingClientRect().bottom;
          expect(firstLineBottom).toBeLessThanOrEqual(consoleBottom);
        }
      }
    } finally {
      surface.container.style.width = "380px";
      setCurrentLanguage(language);
      useStore.setState({ language });
      await wait(100);
    }

    // At the dock-reduced width host names should stay distinct and the live
    // run can be collapsed without losing its identity or the open editor.
    const chips = [...document.querySelectorAll<HTMLElement>(".wb-host-chip")];
    expect(chips).toHaveLength(2);
    expect(
      Math.abs(chips[0].getBoundingClientRect().top - chips[1].getBoundingClientRect().top),
    ).toBeLessThan(2);
    for (const chip of chips) {
      const name = chip.querySelector<HTMLElement>(".wb-host-name")!;
      expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1);
    }
    const editorHeight = document
      .querySelector<HTMLElement>(".wb-center")!
      .getBoundingClientRect().height;
    await userEvent.click(page.getByRole("button", { name: "收起运行控制台" }));
    expect(
      document.querySelector<HTMLElement>(".wb-center")!.getBoundingClientRect().height,
    ).toBeGreaterThan(editorHeight);
    expect(document.querySelector(".wb-status-pill.is-running")).not.toBeNull();
    await userEvent.click(page.getByRole("button", { name: "展开运行控制台" }));
    expect(document.querySelector(".cm-content")).not.toBeNull();
    document.documentElement.style.removeProperty("--panel-font-size");
    surface.container.style.width = "100%";
    await page.viewport(1440, 900);

    // The project switcher reaches the second project without losing the
    // first project's open document.
    await userEvent.click(document.querySelectorAll(".wb-project")[1] as HTMLElement);
    await wait(200);
    expect(useWorkbench.getState().activeWorkspaceId).toBe("w2");
    expect(useWorkbench.getState().docs).toHaveLength(1);
    expect(document.body.textContent).toContain("lab@gpu-01:22");

    // Back to the first project: its document is still open. A save the
    // server refuses as a conflict must keep the draft and offer the two
    // explicit choices, not overwrite silently.
    await useWorkbench.getState().activateWorkspace("w1");
    const id = useWorkbench.getState().docs[0].id;
    useWorkbench.getState().updateDoc(id, `${PYTHON}\n# local experiment\n`);
    vi.mocked(wb.writeText).mockRejectedValue({
      code: "conflict",
      message: "the file changed on the server since it was opened",
    });
    await useWorkbench.getState().saveDoc(id);
    await wait(300);
    expect(document.querySelector(".wb-banner.is-warning")).not.toBeNull();
    expect(document.querySelector(".wb-editor-dot.is-dirty")).not.toBeNull();
    await page.screenshot({ path: "../../artifacts/workbench-conflict.png" });

    // A narrow editor must keep conflict actions reachable without scrolling
    // its tab strip and toolbar out of view or losing the unsaved draft.
    try {
      await page.viewport(900, 560);
      surface.container.style.width = "320px";
      document.documentElement.style.setProperty("--panel-font-size", "18px");
      await wait(100);
      const body = document.querySelector<HTMLElement>(".wb-body")!;
      const tabs = document.querySelector<HTMLElement>(".wb-editor-tabs")!;
      const warning = document.querySelector<HTMLElement>(".wb-editor .wb-banner.is-warning")!;
      const toolbar = document.querySelector<HTMLElement>(".wb-editor-toolbar")!;
      const toolbarActions = document.querySelector<HTMLElement>(".wb-editor-actions")!;
      const tabsTop = tabs.getBoundingClientRect().top;
      const keepEditing = page.getByRole("button", { name: "继续编辑", exact: true }).element();
      const choices = [...warning.querySelectorAll<HTMLButtonElement>(".wb-banner-actions button")];
      expect(choices).toHaveLength(3);
      for (const choice of choices) {
        choice.focus();
        await wait(100);
        const action = choice.getBoundingClientRect();
        const visibleBody = body.getBoundingClientRect();
        const visibleWarning = warning.getBoundingClientRect();
        expect(document.activeElement).toBe(choice);
        expect(action.left).toBeGreaterThanOrEqual(visibleBody.left - 0.5);
        expect(action.right).toBeLessThanOrEqual(visibleBody.right + 0.5);
        expect(action.top).toBeGreaterThanOrEqual(visibleWarning.top - 0.5);
        expect(action.bottom).toBeLessThanOrEqual(visibleWarning.bottom + 0.5);
        expect(Math.abs(tabs.getBoundingClientRect().top - tabsTop)).toBeLessThan(1);
      }
      expect(document.activeElement).toBe(keepEditing);
      expect(toolbarActions.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        toolbar.getBoundingClientRect().bottom + 0.5,
      );
      await userEvent.keyboard("{Enter}");
      expect(document.querySelector(".wb-editor .wb-banner.is-warning")).toBeNull();
      const kept = useWorkbench.getState().docs.find((item) => item.id === id)!;
      expect(kept.content).not.toBe(kept.savedContent);
    } finally {
      document.documentElement.style.removeProperty("--panel-font-size");
      surface.container.style.width = "100%";
      await page.viewport(1440, 900);
    }
  }, 60_000);

  it("lists a stored draft with the server and project it belongs to", async () => {
    localStorage.clear();
    useStore.setState({ theme: "light", bufferFontSize: 13, panelFontSize: 12 });
    document.documentElement.dataset.theme = "light";
    vi.mocked(wb.loadData).mockResolvedValue(structuredClone(DATA));
    vi.mocked(wb.listFiles).mockResolvedValue({
      root: "",
      files: [],
      truncated: false,
      source: "git",
    });
    vi.mocked(wb.gitState).mockResolvedValue({
      isRepository: false,
      branch: "",
      commit: "",
      dirty: false,
      files: [],
      diffSha256: "",
      diffBytes: 0,
      diffTruncated: false,
      note: "",
    });
    vi.mocked(wb.probe).mockResolvedValue({
      os: "Linux 5.15",
      home: "/home/lab",
      shell: "/bin/bash",
      git: true,
      tmux: true,
      python: "/usr/bin/python3",
      conda: true,
      nvidiaSmi: true,
      scheduler: null,
      isRepository: false,
      rootExists: true,
      paths: [],
    });
    vi.mocked(connectedTabFor).mockReturnValue(tab());
    vi.mocked(ensureSessionFor).mockResolvedValue("s1");

    await useWorkbench.getState().init();
    useWorkbench.setState({ draftsOpen: true });
    await page.viewport(1440, 900);
    mount(createElement(Workbench));
    await wait(400);

    const body = document.body.textContent ?? "";
    // The recovery list names the project, the server identity and the file,
    // and offers the three actions; nothing here is a silent restore.
    expect(body).toContain("src/loss.py");
    expect(body).toContain("gpu-01");
    expect(body).toContain("vfi-baseline");
    expect(body).toContain("丢弃");
    expect(body).toContain("打开");
    await page.screenshot({ path: "../../artifacts/workbench-drafts.png" });
  }, 60_000);
});
