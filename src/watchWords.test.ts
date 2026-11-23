import { describe, expect, it } from "vitest";

import { watchSeverity } from "./watchWords";

describe("watchSeverity", () => {
  it("marks the words a log reader scans for", () => {
    expect(watchSeverity("ERROR database is unreachable")).toBe("error");
    expect(watchSeverity("fatal: not a git repository")).toBe("error");
    expect(watchSeverity("panic: runtime error")).toBe("error");
    expect(watchSeverity("Build FAILED in 12s")).toBe("error");
    expect(watchSeverity("Connection reset by peer: exception")).toBe("error");
    expect(watchSeverity("warning: unused variable")).toBe("warn");
    expect(watchSeverity("WARN  deprecated option")).toBe("warn");
    expect(watchSeverity("retrying in 5s")).toBe("warn");
    expect(watchSeverity("request timed out")).toBe("warn");
  });

  it("leaves ordinary output alone", () => {
    expect(watchSeverity("")).toBeNull();
    expect(watchSeverity("total 42 files changed")).toBeNull();
    expect(watchSeverity("0 errors, 2 warnings")).toBeNull();
    expect(watchSeverity("errors: none")).toBeNull();
    expect(watchSeverity("errorlog.txt is not a message")).toBeNull();
  });

  it("prefers the error mark when a line has both", () => {
    expect(watchSeverity("warning then ERROR")).toBe("error");
  });
});
