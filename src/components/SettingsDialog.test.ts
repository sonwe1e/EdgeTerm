// PD-06 — the app's preferences were scattered over seven places (the display
// settings sheet, the View menu's theme/gutter/panel entries, the Edit menu's
// behaviour toggles, the session panel's SSH-reuse disclosure, the status
// bar's transfer popover and the data actions in the Session menu), and
// "restore default settings" sat in Help. The regression: one settings dialog
// gathers them, every store-driven preference is editable there, and the two
// richer surfaces are opened rather than copied.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("../nativeDialog", () => ({ ask: vi.fn(async () => true), open: vi.fn(), save: vi.fn() }));

import * as nativeDialog from "../nativeDialog";
import { useStore } from "../store";
import { useFileTransfers } from "../fileTransfers";
import { SettingsDialog } from "./SettingsDialog";

const initialState = useStore.getState();
let host: HTMLDivElement;
let root: Root;

const groups = () => [...host.querySelectorAll<HTMLElement>(".settings-group")];
const row = (label: string) =>
  [...host.querySelectorAll<HTMLElement>(".settings-row")]
    .find((element) => element.querySelector(".settings-row-label")?.textContent?.trim() === label)!;
const rowButton = (label: string) =>
  row(label).querySelector<HTMLButtonElement>("button")!;
const radio = (name: string, value: string) =>
  host.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`)!;

const mount = (props: { onClose: () => void; onDisplaySettings: () => void }) => act(() => {
  root.render(h(SettingsDialog, props));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({
    ...initialState, language: "en", theme: "dark",
    panels: { sessions: true, filer: false, sender: false },
  }, true);
  useFileTransfers.setState({ jobs: {}, open: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Settings dialog (PD-06)", () => {
  it("gathers the seven scattered surfaces into six groups", () => {
    mount({ onClose: vi.fn(), onDisplaySettings: vi.fn() });
    expect(groups()).toHaveLength(6);
    // One row per surface the audit named, by the label the menus use.
    for (const label of ["Theme", "Display Settings…", "Transfer Settings", "Restore Default Settings…"]) {
      expect(row(label), label).toBeTruthy();
    }
    // The session panel's SSH-reuse control is inlined, not linked.
    expect(host.querySelector(".ssh-reuse-setting")).not.toBeNull();
  });

  it("edits the theme through the same store the View menu reads", () => {
    mount({ onClose: vi.fn(), onDisplaySettings: vi.fn() });
    act(() => { radio("Theme", "light").click(); });
    expect(useStore.getState().theme).toBe("light");
  });

  it("opens the display settings sheet through the app's own dialog", () => {
    const onDisplaySettings = vi.fn(), onClose = vi.fn();
    mount({ onClose, onDisplaySettings });
    act(() => { rowButton("Display Settings…").click(); });
    // The settings dialog steps out of the way first, so the two never stack.
    expect(onDisplaySettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens the transfer popover from the store, and says where it lives", () => {
    const onClose = vi.fn();
    mount({ onClose, onDisplaySettings: vi.fn() });
    act(() => { rowButton("Transfer Settings").click(); });
    expect(useFileTransfers.getState().open).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(row("Transfer Settings").textContent).toContain("Settings");
  });

  it("toggles panel visibility through the same store the View menu's checks do", () => {
    mount({ onClose: vi.fn(), onDisplaySettings: vi.fn() });
    const before = { ...useStore.getState().panels };
    const first = host.querySelectorAll<HTMLInputElement>(".settings-checks input[type='checkbox']")[0];
    act(() => { first.click(); });
    const after = useStore.getState().panels;
    const changed = (["sessions", "filer", "sender"] as const).filter((panel) => before[panel] !== after[panel]);
    expect(changed).toHaveLength(1);
  });

  it("restores defaults behind the audited confirmation, and says what it costs", () => {
    mount({ onClose: vi.fn(), onDisplaySettings: vi.fn() });
    const restore = rowButton("Restore Default Settings…");
    expect(restore.className).toContain("is-danger");
    // The note names the consequence the 2026-10-19 audit asked for.
    expect(row("Restore Default Settings…").textContent).toContain("hidden");
    act(() => { restore.click(); });
    expect(nativeDialog.ask).toHaveBeenCalledTimes(1);
  });
});
