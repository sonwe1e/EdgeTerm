import { describe, expect, it } from "vitest";

import { languageFor } from "./codemirror";

// The editor opens local files as well as remote ones, and a local path on
// Windows is spelled with backslashes. A name-matched language is chosen by the
// file's own name, so reading the name with the wrong separator silently drops
// the highlighting instead of failing.
describe("languageFor", () => {
  it("reads the name of a Windows path", () => {
    expect(languageFor("C:\\proj\\Dockerfile")).toBe("shell");
    expect(languageFor("C:\\proj\\Makefile")).toBe("shell");
    expect(languageFor("C:\\proj\\app\\main.py")).toBe("python");
    expect(languageFor("C:/proj/main.rs".replace(".rs", ".json"))).toBe("json");
  });

  it("reads the name of a remote path", () => {
    expect(languageFor("/srv/app/Dockerfile")).toBe("shell");
    expect(languageFor("/srv/app/main.py")).toBe("python");
    expect(languageFor("notes.txt")).toBe("text");
  });
});
