import { describe, expect, it } from "vitest";
import { blamedRecordingFolder } from "./recordingFolder";

describe("blamedRecordingFolder", () => {
  it("names the folder the session would write to", () => {
    expect(blamedRecordingFolder({ record: true, recordDir: "D:/logs" }, "/default")).toBe(
      "D:/logs",
    );
    expect(blamedRecordingFolder({ record: true, recordDir: "  " }, "/default")).toBe("/default");
  });

  it("says nothing when recording is off or no folder is known", () => {
    expect(blamedRecordingFolder({ record: false, recordDir: "/logs" }, "/default")).toBeNull();
    expect(blamedRecordingFolder({ record: true }, "  ")).toBeNull();
  });
});
