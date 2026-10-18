import { describe, expect, it } from "vitest";
import {
  baselineOf,
  experimentRoot,
  experimentsOf,
  fuzzyFilter,
  fuzzyScore,
  hostIdentities,
  isRunLive,
  joinRemote,
  normalizeData,
  normalizeServer,
  relativePath,
  runCodeId,
  runStatusKey,
  runsOf,
  samplingIntervalMs,
  serverKey,
  staleAfterMs,
} from "./model";
import type { RunRecord, Workspace, WorkspaceData } from "./types";

const server = (host: string, profileId: string) =>
  normalizeServer({
    profileId,
    name: host,
    host,
    port: 22,
    username: "lab",
  });

const workspace = (
  id: string,
  name: string,
  host: string,
  root: string,
  profileId = "profile-1",
): Workspace => ({
  id,
  name,
  server: server(host, profileId),
  root,
  env: "conda activate vfi",
  commands: [],
  runRoot: "",
  baselineExperimentId: null,
  createdAt: 1,
  updatedAt: 1,
});

const data: WorkspaceData = {
  workspaces: [
    workspace("w1", "baseline", "gpu-01", "/data/vfi/base"),
    workspace("w2", "ablation A", "gpu-01", "/data/vfi/abl_a"),
    workspace("w3", "ablation B", "gpu-02", "/mnt/fast/abl_b", "profile-2"),
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
      name: "loss variant",
      kind: "variant",
      baselineId: "e1",
      root: "/data/vfi/abl_a",
      branch: null,
      notes: "changed interpolation loss",
      createdAt: 2,
      updatedAt: 2,
    },
  ],
  runs: [],
};

const run = (id: string, workspaceId: string, experimentId: string, startedAt: number): RunRecord => ({
  id,
  workspaceId,
  experimentId,
  server: server("gpu-01", "profile-1"),
  root: "/data/vfi/base",
  command: "python train.py",
  env: "",
  gpu: "0",
  scheduler: null,
  submitOnly: false,
  mode: "tmux",
  status: "running",
  startedAt,
  endedAt: null,
  exitCode: null,
  code: {
    branch: "main",
    commit: "0123456789abcdef",
    dirty: true,
    dirtyFiles: ["src/loss.py"],
    diffSha256: "abc",
    diffBytes: 10,
    diffTruncated: false,
    isRepository: true,
  },
  snapshot: {
    mode: "code",
    path: "/data/vfi/base/.edgeterm/runs/r1/code",
    files: 12,
    bytes: 1024,
    skipped: 0,
    verified: true,
    note: "",
  },
  binding: {
    execution: "workspace",
    executedFrom: "/data/vfi/base",
    workspaceRoot: "/data/vfi/base",
    isolated: false,
    snapshotVerified: true,
    unsynced: [],
    links: [],
    note: "",
  },
  runDir: "/data/vfi/base/.edgeterm/runs/r1",
  logPath: "",
  taskName: "et-r1",
  resumedFrom: null,
  note: "",
  lastSeenAt: startedAt,
});

describe("project and server identity", () => {
  it("keeps the server key stable while the display name changes", () => {
    const first = server("gpu-01", "profile-1");
    const renamed = { ...first, name: "renamed" };
    expect(serverKey(first)).toBe("lab@gpu-01:22");
    expect(serverKey(renamed)).toBe(serverKey(first));
  });

  it("separates projects by root even when they share a login", () => {
    const [base, ablation, other] = data.workspaces;
    expect(serverKey(base.server)).toBe(serverKey(ablation.server));
    expect(base.root).not.toBe(ablation.root);
    expect(serverKey(other.server)).not.toBe(serverKey(base.server));
  });

  it("normalizes records missing fields from an older file", () => {
    const normalized = normalizeData({
      workspaces: [
        {
          id: "w",
          name: "project",
          root: "/data",
          server: { profileId: "p", host: "host" },
        },
      ],
    });
    expect(normalized.workspaces[0].server.port).toBe(22);
    expect(normalized.workspaces[0].commands).toEqual([]);
    expect(normalized.workspaces[0].runRoot).toBe("");
    expect(normalized.experiments).toEqual([]);
    expect(normalized.runs).toEqual([]);
  });
});

describe("experiments", () => {
  it("lists baselines before variants and resolves each root", () => {
    const experiments = experimentsOf(data, "w2");
    expect(experiments.map((experiment) => experiment.id)).toEqual(["e2"]);
    expect(experimentRoot(data.workspaces[1], experiments[0])).toBe("/data/vfi/abl_a");
    expect(experimentRoot(data.workspaces[0], null)).toBe("/data/vfi/base");
  });

  it("finds the baseline and ignores another project's experiments", () => {
    expect(baselineOf(data, data.workspaces[0])?.id).toBe("e1");
    expect(baselineOf(data, data.workspaces[1])).toBeNull();
  });

  it("answers runs by project and experiment, newest first", () => {
    const runs = [run("r1", "w1", "e1", 1), run("r2", "w1", "e1", 5), run("r3", "w2", "e2", 9)];
    expect(runsOf({ ...data, runs }, "w1").map((item) => item.id)).toEqual(["r2", "r1"]);
    expect(runsOf({ ...data, runs }, "w1", "e1")).toHaveLength(2);
    expect(runsOf({ ...data, runs }, "w2")).toHaveLength(1);
  });
});

describe("run presentation", () => {
  it("shows the commit and marks uncommitted code", () => {
    expect(runCodeId(run("r", "w1", "e1", 1))).toBe("01234567+dirty");
    const clean = run("r", "w1", "e1", 1);
    clean.code = { ...clean.code, dirty: false };
    expect(runCodeId(clean)).toBe("01234567");
    const noRepo = run("r", "w1", "e1", 1);
    noRepo.code = { ...noRepo.code, isRepository: false };
    expect(runCodeId(noRepo)).toBe("no repo");
  });

  it("keeps submitted and running distinct from finished", () => {
    expect(isRunLive("running")).toBe(true);
    expect(isRunLive("submitted")).toBe(true);
    expect(isRunLive("finished")).toBe(false);
    expect(runStatusKey("lost")).toBe("wb.statusLost");
    expect(runStatusKey("stopped")).toBe("wb.statusStopped");
  });
});

describe("paths and hosts", () => {
  it("joins and relativizes remote paths without doubling slashes", () => {
    expect(joinRemote("/data/base/", "src/a.py")).toBe("/data/base/src/a.py");
    expect(joinRemote("/data/base", "/abs/a.py")).toBe("/abs/a.py");
    expect(relativePath("/data/base", "/data/base/src/a.py")).toBe("src/a.py");
    expect(relativePath("/data/base", "/data/baseball/a.py")).toBe("/data/baseball/a.py");
  });

  it("groups three projects onto two hosts", () => {
    const hosts = hostIdentities(data.workspaces);
    expect(hosts).toHaveLength(2);
    const shared = hosts.find((host) => host.key === "lab@gpu-01:22");
    expect(shared?.workspaceIds).toEqual(["w1", "w2"]);
    expect(hosts.find((host) => host.key === "lab@gpu-02:22")?.workspaceIds).toEqual(["w3"]);
  });

  it("samples less often while the window is hidden", () => {
    expect(samplingIntervalMs(true)).toBeLessThan(samplingIntervalMs(false));
    expect(staleAfterMs(true)).toBeLessThan(staleAfterMs(false));
  });
});

describe("quick open", () => {
  it("ranks a basename hit above a deeper directory hit", () => {
    const files = ["src/model.py", "docs/model_notes.md", "tools/model.py"];
    const matches = fuzzyFilter("model.py", files, 3);
    expect(matches).toEqual(["src/model.py", "tools/model.py"]);
  });

  it("matches subsequences and rejects missing characters", () => {
    expect(fuzzyScore("tr", "src/train.py")).not.toBeNull();
    expect(fuzzyScore("xyz", "src/train.py")).toBeNull();
    expect(fuzzyFilter("", ["b.py", "a.py"], 2)).toEqual(["a.py", "b.py"]);
  });
});
