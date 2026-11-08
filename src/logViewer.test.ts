import { describe, expect, it } from "vitest";
import type { LogWindow } from "./api";
import { classifyLogFollow, logMatches, LOG_WINDOW_BYTES } from "./logViewer";

function windowWith(overrides: Partial<LogWindow> = {}): LogWindow {
  return {
    path: "/var/log/service.log",
    start: 0,
    end: 10,
    size: 10,
    content: "0123456789",
    encoding: "UTF-8",
    modifiedAt: 123,
    ...overrides,
  };
}

describe("bounded, literal log search", () => {
  it("matches text literally, including regex metacharacters", () => {
    expect(logMatches("a.* b.* c", ".*")).toEqual([1, 5]);
    expect(logMatches("AAAAA", "AA")).toEqual([0, 2]);
    expect(logMatches("hello", "")).toEqual([]);
    expect(logMatches("hello", "x")).toEqual([]);
  });

  it("caps the number of results even for long, repetitive text", () => {
    expect(logMatches("x".repeat(LOG_WINDOW_BYTES), "x")).toHaveLength(100);
    expect(logMatches("abc", "a", 0)).toEqual([]);
    expect(logMatches("abc", "a", 1)).toEqual([0]);
  });
});

describe("bounded follow", () => {
  it("does nothing for a stable file", () => {
    expect(classifyLogFollow(windowWith(), windowWith({ start: 10, end: 10, content: "" }))).toBe(
      "idle",
    );
  });

  it("appends only when contiguous and within the window limit", () => {
    const next = windowWith({ start: 10, end: 12, size: 12, content: "ab" });
    expect(classifyLogFollow(windowWith(), next)).toBe("append");
    expect(classifyLogFollow(windowWith(), { ...next, start: 11 })).toBe("reload");
  });

  it("reloads the tail instead of retaining unlimited content", () => {
    const previous = windowWith({ start: 0, end: LOG_WINDOW_BYTES, size: LOG_WINDOW_BYTES });
    const next = windowWith({
      start: LOG_WINDOW_BYTES,
      end: LOG_WINDOW_BYTES + 1000,
      size: LOG_WINDOW_BYTES + 1000,
    });
    expect(classifyLogFollow(previous, next)).toBe("reload");
    expect(classifyLogFollow(windowWith(), { ...next, start: 10 })).toBe("reload");
  });

  it("detects truncation, same-size replacement and timestamp-less files", () => {
    const previous = windowWith();
    expect(classifyLogFollow(previous, windowWith({ start: 5, end: 5, size: 5 }))).toBe("rotated");
    expect(classifyLogFollow(previous, windowWith({ start: 10, end: 10, modifiedAt: 124 }))).toBe(
      "replaced",
    );
    expect(classifyLogFollow(previous, windowWith({ start: 10, end: 10, modifiedAt: null }))).toBe(
      "idle",
    );
  });
});
