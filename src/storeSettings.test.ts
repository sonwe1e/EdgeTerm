import { beforeEach, describe, expect, it, vi } from "vitest";

// The store reaches platform.ts through the shortcut table, and IS_MAC is a
// build-time constant vitest does not define.
vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import { detectLanguage } from "./i18n";
import { scrollbackMegabytes, TERMINAL_SCROLLBACK, useStore } from "./store";

const initialState = useStore.getState();

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ ...initialState }, true);
});

describe("cursor settings", () => {
  it("default to a blinking block", () => {
    const state = useStore.getState();
    expect(state.cursorStyle).toBe("block");
    expect(state.cursorBlink).toBe(true);
  });

  it("persist the shape and the blink switch", () => {
    const store = useStore.getState();
    store.setCursorStyle("bar");
    store.setCursorBlink(false);

    expect(useStore.getState().cursorStyle).toBe("bar");
    expect(useStore.getState().cursorBlink).toBe(false);
    expect(localStorage.getItem("edgeterm.cursorStyle")).toBe("bar");
    expect(localStorage.getItem("edgeterm.cursorBlink")).toBe("off");
  });

  it("travel with a data export and survive a malformed import", () => {
    const store = useStore.getState();
    store.setCursorStyle("underline");
    store.setCursorBlink(false);
    const exported = useStore.getState().exportSettings();
    expect(exported.cursorStyle).toBe("underline");
    expect(exported.cursorBlink).toBe(false);

    store.resetSettings();
    expect(useStore.getState().cursorStyle).toBe("block");
    expect(useStore.getState().cursorBlink).toBe(true);
    expect(localStorage.getItem("edgeterm.cursorStyle")).toBeNull();
    expect(localStorage.getItem("edgeterm.cursorBlink")).toBeNull();

    useStore.getState().applySettings(exported);
    expect(useStore.getState().cursorStyle).toBe("underline");
    expect(useStore.getState().cursorBlink).toBe(false);

    // A shape the terminal does not draw, or a blink flag that is not a
    // boolean, leaves the current values alone.
    useStore.getState().applySettings({ cursorStyle: "beam", cursorBlink: "yes" });
    expect(useStore.getState().cursorStyle).toBe("underline");
    expect(useStore.getState().cursorBlink).toBe(false);
  });
});

describe("terminal scrollback", () => {
  it("defaults to 10,000 lines and clamps what is stored or imported", () => {
    expect(useStore.getState().terminalScrollback).toBe(10_000);

    useStore.getState().setTerminalScrollback(5_000_000);
    expect(useStore.getState().terminalScrollback).toBe(1_000_000);
    useStore.getState().setTerminalScrollback(Number.NaN);
    expect(useStore.getState().terminalScrollback).toBe(10_000);
    // The clamps above are literals so a changed constant cannot silently
    // redefine them; this pins the constant itself.
    expect(TERMINAL_SCROLLBACK).toEqual({ min: 0, max: 1_000_000, default: 10_000 });
  });

  it("estimates the floor of the memory a session holds", () => {
    // Three 32-bit words per cell, every column of every line.
    expect(scrollbackMegabytes(10_000, 200)).toBeCloseTo(22.89, 1);
    expect(scrollbackMegabytes(0)).toBe(0);
    expect(scrollbackMegabytes(-5)).toBe(0);
  });
});

describe("panel layout", () => {
  it("stores only a layout that differs from the default", () => {
    const store = useStore.getState();
    store.movePanel("filer", "bottom", "sender");
    expect(useStore.getState().panelDocks).toEqual({
      left: ["sessions"],
      right: [],
      bottom: ["filer", "sender"],
    });
    expect(
      JSON.parse(localStorage.getItem("edgeterm.panelDocks") ?? "null"),
    ).toEqual(useStore.getState().panelDocks);

    useStore.getState().resetPanelLayout();
    expect(localStorage.getItem("edgeterm.panelDocks")).toBeNull();
  });

  it("shows a hidden panel that is given a place", () => {
    expect(useStore.getState().panels.filer).toBe(false);
    useStore.getState().movePanel("filer", "left");
    expect(useStore.getState().panels.filer).toBe(true);
  });

  it("travels with a data export and is reset with the defaults", () => {
    useStore.getState().movePanel("sessions", "right");
    const exported = useStore.getState().exportSettings();
    expect(exported.panelDocks.right).toEqual(["filer", "sessions"]);

    useStore.getState().resetSettings();
    expect(useStore.getState().panelDocks.left).toEqual(["sessions"]);
    expect(localStorage.getItem("edgeterm.panelDocks")).toBeNull();

    useStore.getState().applySettings(exported);
    expect(useStore.getState().panelDocks.right).toEqual(["filer", "sessions"]);

    // A file without the field leaves the layout alone.
    useStore.getState().applySettings({ panelDocks: "left" });
    expect(useStore.getState().panelDocks.right).toEqual(["filer", "sessions"]);
  });
});

describe("filer sort preference", () => {
  it("is shared through the store and travels with exports", () => {
    useStore.getState().setFilerSort({ key: "size", direction: "desc" });
    expect(useStore.getState().filerSort).toEqual({ key: "size", direction: "desc" });
    expect(JSON.parse(localStorage.getItem("edgeterm.filerSort") ?? "null")).toEqual({
      key: "size",
      direction: "desc",
    });

    const exported = useStore.getState().exportSettings();
    expect(exported.filerSort).toEqual({ key: "size", direction: "desc" });

    useStore.getState().resetSettings();
    expect(useStore.getState().filerSort).toEqual({ key: "name", direction: "asc" });
    expect(localStorage.getItem("edgeterm.filerSort")).toBeNull();

    useStore.getState().applySettings(exported);
    expect(useStore.getState().filerSort).toEqual({ key: "size", direction: "desc" });

    // A sort a settings file must never produce leaves the choice alone.
    useStore.getState().applySettings({ filerSort: { key: "bogus", direction: "asc" } });
    expect(useStore.getState().filerSort).toEqual({ key: "size", direction: "desc" });
  });
});

describe("registered panel preferences", () => {
  it("carry out with an export and back in with an import", () => {
    localStorage.setItem("edgeterm.senderRepeat", JSON.stringify({ every: 120, times: 3 }));
    localStorage.setItem("edgeterm.senderSaveLevel", "profile");
    localStorage.setItem("edgeterm.filerOpenWith", JSON.stringify(["C:/tools/app.exe"]));
    localStorage.setItem(
      "edgeterm.transfer-options",
      JSON.stringify({ requests: 8, chunkKib: 64, files: 2, durable: true }),
    );
    const exported = useStore.getState().exportSettings();
    expect(exported.preferences).toEqual({
      "edgeterm.senderRepeat": { every: 120, times: 3 },
      "edgeterm.senderSaveLevel": "profile",
      "edgeterm.filerOpenWith": ["C:/tools/app.exe"],
      "edgeterm.transfer-options": { requests: 8, chunkKib: 64, files: 2, durable: true },
    });

    localStorage.clear();
    useStore.getState().applySettings(exported);
    expect(JSON.parse(localStorage.getItem("edgeterm.senderRepeat") ?? "null")).toEqual({
      every: 120,
      times: 3,
    });
    expect(localStorage.getItem("edgeterm.senderSaveLevel")).toBe("profile");
    expect(JSON.parse(localStorage.getItem("edgeterm.filerOpenWith") ?? "null")).toEqual([
      "C:/tools/app.exe",
    ]);
    expect(JSON.parse(localStorage.getItem("edgeterm.transfer-options") ?? "null")).toEqual({
      requests: 8,
      chunkKib: 64,
      files: 2,
      durable: true,
    });
  });

  it("imports no key that is not registered, and resets them all", () => {
    useStore.getState().applySettings({
      preferences: { "edgeterm.not-registered": "value" },
    });
    expect(localStorage.getItem("edgeterm.not-registered")).toBeNull();

    localStorage.setItem("edgeterm.senderRepeat", "1");
    localStorage.setItem("edgeterm.senderSaveLevel", "1");
    localStorage.setItem("edgeterm.filerOpenWith", "1");
    localStorage.setItem("edgeterm.transfer-options", "1");
    useStore.getState().resetSettings();
    for (const key of [
      "edgeterm.senderRepeat",
      "edgeterm.senderSaveLevel",
      "edgeterm.filerOpenWith",
      "edgeterm.transfer-options",
    ]) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });
});

describe("restore default settings", () => {
  it("returns the interface to the system language and forgets the choice", () => {
    useStore.getState().setLanguage("zh-CN");
    expect(localStorage.getItem("edgeterm.language")).toBe("zh-CN");
    useStore.getState().resetSettings();
    expect(useStore.getState().language).toBe(detectLanguage());
    expect(localStorage.getItem("edgeterm.language")).toBeNull();
  });
});
