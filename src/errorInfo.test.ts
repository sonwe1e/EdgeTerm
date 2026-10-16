import { describe, expect, it } from "vitest";
import { errorInfo, errorText, isCancelled } from "./errorInfo";

describe("errorInfo", () => {
  it("reads the structured shape commands send now", () => {
    expect(
      errorInfo({
        code: "connectionFailed",
        message: "cannot reach host:22",
        operation: "open_session",
        requestId: "6d1b3f8a",
      }),
    ).toEqual({
      code: "connectionFailed",
      message: "cannot reach host:22",
      operation: "open_session",
      requestId: "6d1b3f8a",
    });
  });

  it("treats optional fields as absent when they are null or empty", () => {
    expect(
      errorInfo({ code: "timeout", message: "dial timed out", operation: null, requestId: "" }),
    ).toEqual({ code: "timeout", message: "dial timed out" });
  });

  it("keeps legacy string errors working", () => {
    expect(errorText("something broke")).toBe("something broke");
    expect(errorInfo("something broke")).toEqual({
      code: "unknown",
      message: "something broke",
    });
  });

  it("reads a JS Error and any other thrown value", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorInfo(undefined)).toEqual({ code: "unknown", message: "undefined" });
    expect(errorInfo({ code: "cancelled" })).toEqual({
      code: "unknown",
      message: "[object Object]",
    });
  });

  it("asks for a cancellation by code first, then by the legacy message", () => {
    expect(
      isCancelled({ code: "cancelled", message: "authentication for alice was cancelled" }),
    ).toBe(true);
    expect(isCancelled("transfer cancelled")).toBe(true);
    expect(isCancelled({ code: "connectionFailed", message: "cannot reach host:22" })).toBe(false);
    expect(isCancelled("authentication failed for alice")).toBe(false);
  });
});
