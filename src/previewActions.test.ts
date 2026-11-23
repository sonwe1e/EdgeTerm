import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./previewClient", () => ({
  startPreview: vi.fn(async () => ({ id: "pv1", url: "http://127.0.0.1:1/report.html" })),
  stopPreview: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { pendingSessionInfo } from "./actions";
import { isPreviewRunning, previewReport, stopReportPreview } from "./previewActions";
import * as previewClient from "./previewClient";
import { useStore, type Tab } from "./store";
import type { SessionProfile } from "./types";

const shell = (id: string): Tab => ({
  info: pendingSessionInfo(id, { id, name: id, kind: "ssh" } as SessionProfile),
  profile: { id, name: id, kind: "ssh" } as SessionProfile,
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const REPORT = "/work/report.html";

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ tabs: [shell("t1")], activeId: "t1" });
});

describe("a report preview", () => {
  it("is running for the session that opened it, and its record follows the session", async () => {
    expect(isPreviewRunning("t1", REPORT)).toBe(false);
    await previewReport("t1", REPORT);
    expect(isPreviewRunning("t1", REPORT)).toBe(true);

    // The session closes: the Rust side took its previews with it, so the
    // stale record must not keep offering a stop that would error.
    useStore.setState({ tabs: [] });
    expect(isPreviewRunning("t1", REPORT)).toBe(false);
    await stopReportPreview("t1", REPORT);
    expect(previewClient.stopPreview).not.toHaveBeenCalled();
  });

  it("stops a live preview through the client", async () => {
    await previewReport("t1", REPORT);
    await stopReportPreview("t1", REPORT);
    expect(previewClient.stopPreview).toHaveBeenCalledWith("pv1");
    expect(isPreviewRunning("t1", REPORT)).toBe(false);
  });
});
