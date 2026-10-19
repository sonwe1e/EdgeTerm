import { beforeEach, expect, it, vi } from "vitest";

const { setStatus } = vi.hoisted(() => ({ setStatus: vi.fn() }));
vi.mock("./api", () => ({
  readAppData: vi.fn(), exportAppData: vi.fn(), importAppData: vi.fn(),
  defaultSshConfigPath: vi.fn().mockResolvedValue("config"), readSshConfig: vi.fn(),
}));
vi.mock("./nativeDialog", () => ({ open: vi.fn(), save: vi.fn(), ask: vi.fn() }));
vi.mock("./store", () => ({ useStore: { getState: () => ({
  setStatus,
  exportSettings: () => ({}),
  applySettings: vi.fn(),
  loadProfiles: vi.fn(async () => {}),
  bumpSenderLibrary: vi.fn(),
}) } }));

import * as api from "./api";
import { setCurrentLanguage } from "./i18n";
import { ask, open, save } from "./nativeDialog";
import { exportAppData, importAppData, importSshConfig } from "./dataTransfer";

beforeEach(() => {
  vi.clearAllMocks();
  setCurrentLanguage("en");
});

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

it("summarises an export with the active language's plurals", async () => {
  vi.mocked(save).mockResolvedValue("out.edgeterm");
  vi.mocked(api.exportAppData).mockResolvedValue({
    profiles: 2, groups: 1, senderCommands: 3, skippedSenderCommands: 0,
  });
  await exportAppData();
  expect(setStatus).toHaveBeenLastCalledWith(
    "Exported 2 sessions, 1 group, 3 Sender commands and settings to out.edgeterm (passwords are not included)",
  );
});

it("asks for an import confirmation in Chinese and reports the merged counts", async () => {
  setCurrentLanguage("zh-CN");
  vi.mocked(open).mockResolvedValue("backup.edgeterm");
  vi.mocked(api.readAppData).mockResolvedValue({
    app: "EdgeTerm", format: 1,
    profiles: [], groups: [], senderCommands: [], settings: { theme: "dark" },
  });
  vi.mocked(ask).mockResolvedValue(true);
  vi.mocked(api.importAppData).mockResolvedValue({
    profiles: 0, groups: 0, senderCommands: 0, skippedSenderCommands: 0,
  });
  await importAppData();
  const [message, options] = vi.mocked(ask).mock.calls[0];
  expect(message).toContain("从“backup.edgeterm”导入 0 个会话");
  expect(message).toContain("不包含会话密码");
  expect(options).toMatchObject({ title: "导入", okLabel: "导入" });
  expect(setStatus).toHaveBeenLastCalledWith("已导入 0 个会话, 0 个分组, 0 条发送命令 及设置");
});
