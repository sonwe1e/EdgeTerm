import { beforeEach, describe, expect, it, vi } from "vitest";

const { setStatus } = vi.hoisted(() => ({ setStatus: vi.fn() }));

vi.mock("./bindings", () => ({
  commands: { openLogDirectory: vi.fn(), exportDiagnostics: vi.fn() },
}));
vi.mock("./nativeDialog", () => ({ save: vi.fn() }));
vi.mock("./store", () => ({ useStore: { getState: () => ({ setStatus }) } }));

import { commands } from "./bindings";
import { exportDiagnostics, openLogDirectory } from "./diagnostics";
import { save } from "./nativeDialog";

const status = () => {
  const calls = setStatus.mock.calls;
  return calls[calls.length - 1]?.[0] as string | undefined;
};

describe("diagnostics menu actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the log directory through the generated command", async () => {
    vi.mocked(commands.openLogDirectory).mockResolvedValue(null);
    await openLogDirectory();
    expect(commands.openLogDirectory).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("reports a failure to open the log directory", async () => {
    vi.mocked(commands.openLogDirectory).mockRejectedValue({
      code: "permissionDenied",
      message: "cannot create C:\\logs",
    });
    await openLogDirectory();
    expect(status()).toContain("cannot create C:\\logs");
  });

  it("exports to the picked file, adding the extension, and names it", async () => {
    vi.mocked(save).mockResolvedValue("C:\\out\\diag");
    vi.mocked(commands.exportDiagnostics).mockResolvedValue(null);
    await exportDiagnostics();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^EdgeTerm-diagnostics-\d{4}-\d{2}-\d{2}\.txt$/),
        filters: [{ name: "Text", extensions: ["txt"] }],
      }),
    );
    expect(commands.exportDiagnostics).toHaveBeenCalledWith("C:\\out\\diag.txt");
    expect(status()).toContain("diag.txt");
  });

  it("keeps a chosen .txt name as-is", async () => {
    vi.mocked(save).mockResolvedValue("C:/out/diag.txt");
    vi.mocked(commands.exportDiagnostics).mockResolvedValue(null);
    await exportDiagnostics();
    expect(commands.exportDiagnostics).toHaveBeenCalledWith("C:/out/diag.txt");
  });

  it("does nothing when the save dialog is cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);
    await exportDiagnostics();
    expect(commands.exportDiagnostics).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("reports a failed export with the backend text", async () => {
    vi.mocked(save).mockResolvedValue("C:/out/diag.txt");
    vi.mocked(commands.exportDiagnostics).mockRejectedValue({
      code: "permissionDenied",
      message: "cannot write C:/out/diag.txt",
      operation: "export_diagnostics",
    });
    await exportDiagnostics();
    expect(status()).toContain("cannot write C:/out/diag.txt");
  });
});
