import { beforeEach, expect, it, vi } from "vitest";

const { setStatus } = vi.hoisted(() => ({ setStatus: vi.fn() }));
vi.mock("./api", () => ({
  readAppData: vi.fn(), exportAppData: vi.fn(),
  defaultSshConfigPath: vi.fn().mockResolvedValue("config"), readSshConfig: vi.fn(),
}));
vi.mock("./nativeDialog", () => ({ open: vi.fn(), save: vi.fn(), ask: vi.fn() }));
vi.mock("./store", () => ({ useStore: { getState: () => ({ setStatus, exportSettings: () => ({}) }) } }));

import * as api from "./api";
import { open, save } from "./nativeDialog";
import { exportAppData, importAppData, importSshConfig } from "./dataTransfer";

beforeEach(() => vi.clearAllMocks());

it("shows a structured backend error when importing damaged app data", async () => {
  vi.mocked(open).mockResolvedValue("broken.edgeterm");
  vi.mocked(api.readAppData).mockRejectedValue({ code: "invalidInput", message: "invalid JSON fixture" });
  await importAppData();
  expect(setStatus).toHaveBeenLastCalledWith("Import failed: invalid JSON fixture");
});

it("shows a structured backend error when exporting app data", async () => {
  vi.mocked(save).mockResolvedValue("out.edgeterm");
  vi.mocked(api.exportAppData).mockRejectedValue({ code: "permissionDenied", message: "read-only folder" });
  await exportAppData();
  expect(setStatus).toHaveBeenLastCalledWith("Export failed: read-only folder");
});

it("shows a structured backend error when reading OpenSSH config", async () => {
  vi.mocked(open).mockResolvedValue("config");
  vi.mocked(api.readSshConfig).mockRejectedValue({ code: "invalidInput", message: "invalid config fixture" });
  await importSshConfig();
  expect(setStatus).toHaveBeenLastCalledWith("Import failed: invalid config fixture");
});
