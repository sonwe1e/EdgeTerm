import { expect, it } from "vitest";
import { cdCommand } from "./filerShellPath";

it("quotes a POSIX path for the remote shell", () => {
  expect(cdCommand("/srv/app")).toBe("cd '/srv/app'");
  expect(cdCommand("/home/me/my project")).toBe("cd '/home/me/my project'");
  // A quote inside the name must not end the quoted string.
  expect(cdCommand("/home/it's")).toBe("cd '/home/it'\\''s'");
});

it("quotes a Windows path for the local shell", () => {
  expect(cdCommand("C:\\Users\\me\\project")).toBe("cd 'C:\\Users\\me\\project'");
  expect(cdCommand("C:\\Users\\O'Brien")).toBe("cd 'C:\\Users\\O''Brien'");
});

it("asks for nothing when there is no folder", () => {
  expect(cdCommand("")).toBeNull();
  expect(cdCommand("   ")).toBeNull();
});
