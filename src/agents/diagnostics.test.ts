import { afterEach, expect, it, vi } from "vitest";
import { piConfigs, usePiResumeHint } from "./diagnostics";
import * as files from "../editor/textFile";
import type { TextFile } from "../editor/editorTypes";
vi.mock("../editor/textFile", () => ({ readText: vi.fn(), writeText: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("checks host and project separately and preserves settings behind a hash check", async () => {
  const global = {
    content: '{"fullscreenExitOutput":"resume-hint","theme":"custom"}',
    hash: "global",
    eol: "lf",
    bom: false,
    encoding: "UTF-8",
  } as TextFile;
  const project = {
    ...global,
    content: '{"fullscreenExitOutput":"transcript","theme":"project"}',
    hash: "project",
  };
  vi.mocked(files.readText).mockResolvedValueOnce(global).mockResolvedValueOnce(project);
  const configs = await piConfigs(
    "ssh-1",
    { home: "/home/me", configRoot: "/home/me/.pi/agent", executable: "pi", version: "1.4.0" },
    "/work/repo",
  );
  expect(files.readText).toHaveBeenCalledWith("ssh-1", "/work/repo/.pi/settings.json");
  expect(configs.map((row) => row.exit)).toEqual(["resume-hint", "transcript"]);
  vi.mocked(files.writeText).mockResolvedValue({ uncertain: false } as Awaited<
    ReturnType<typeof files.writeText>
  >);
  await usePiResumeHint("ssh-1", configs[1]);
  const [id, write] = vi.mocked(files.writeText).mock.calls[0];
  expect(id).toBe("ssh-1");
  expect(write.expectedHash).toBe("project");
  expect(JSON.parse(write.content)).toEqual({
    theme: "project",
    fullscreenExitOutput: "resume-hint",
  });
});
it("keeps an unreadable configuration unknown and refuses to overwrite it", async () => {
  vi.mocked(files.readText).mockRejectedValue(new Error("permission denied"));
  const [config] = await piConfigs(
    null,
    { home: "/home/me", configRoot: "/home/me/.pi/agent", executable: "pi", version: "1.4.0" },
    "",
  );
  expect(config.exit).toBeNull();
  expect(config.error).toContain("permission denied");
  await expect(usePiResumeHint(null, config)).rejects.toThrow();
  expect(files.writeText).not.toHaveBeenCalled();
});
