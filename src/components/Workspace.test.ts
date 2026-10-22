// PD-05 — a fresh install showed only the session tree and a hero button:
// the Filer, the Sender and the Workbench were all default-hidden with no
// discoverable entry, so the product's headline capabilities (file transfer
// above all) were invisible on the first screen. The regression: the empty
// state lists the three capabilities with their real chords, each entry
// performs its action and then names the action now in force, and the entry
// survives its own label flip so a keyboard user keeps focus.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  listSenderCommands: vi.fn(async () => []),
}));

import { useStore } from "../store";
import { chordLabel, type KeyChord } from "../shortcuts";
import { useWorkbench } from "../workbench/store";
import { Workspace } from "./Workspace";

const initialState = useStore.getState();
let host: HTMLDivElement;
let root: Root;

const entries = () => [...host.querySelectorAll<HTMLButtonElement>(".term-empty-entry")];
const entryByLabel = (label: string) =>
  entries().find((button) => button.querySelector(".term-empty-entry-label")?.textContent?.startsWith(label))!;

const mount = () => act(() => {
  root.render(h(Workspace, { onNewSession: vi.fn() }));
});

const chord = (over: Partial<KeyChord>): KeyChord => ({
  ctrl: false, alt: false, shift: false, meta: false, code: "KeyK", ...over,
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({
    ...initialState, language: "en", tabs: [], activeId: null, profiles: [], groups: [],
    panels: { sessions: true, filer: false, sender: false },
  }, true);
  useWorkbench.setState({ view: "terminals" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Workspace empty state capability entries (PD-05)", () => {
  it("lists the three capabilities the hero state used to omit, each with a hint", () => {
    mount();
    expect(entries()).toHaveLength(3);
    for (const label of ["Open File Panel", "Open Sender", "Open Workbench"]) {
      const entry = entryByLabel(label);
      expect(entry).toBeTruthy();
      // Every entry explains itself; a bare verb is not discoverability.
      expect(entry.querySelector(".term-empty-entry-hint")?.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it("shows the panels' real chords, and none for the unbound workbench", () => {
    mount();
    const state = useStore.getState();
    const filerChord = chordLabel(state.shortcuts.panelFiler);
    expect(filerChord).toBeTruthy();

    expect(entryByLabel("Open File Panel").querySelector("kbd")?.textContent).toBe(filerChord);
    expect(entryByLabel("Open Sender").querySelector("kbd")?.textContent)
      .toBe(chordLabel(state.shortcuts.panelSender));
    // The workbench has no bound command; the entry must not invent one.
    expect(entryByLabel("Open Workbench").querySelector("kbd")).toBeNull();

    // The accessible name carries the label and its chord, the way the
    // menu bar's own buttons name themselves.
    expect(entryByLabel("Open File Panel").getAttribute("aria-label"))
      .toBe(`Open File Panel (${filerChord})`);
  });

  it("tracks a rebound chord instead of a written-down one", () => {
    mount();
    const before = entryByLabel("Open File Panel").querySelector("kbd")?.textContent;
    act(() => {
      useStore.setState((state) => ({
        shortcuts: { ...state.shortcuts, panelFiler: chord({ ctrl: true, alt: true, code: "KeyK" }) },
      }));
    });
    const after = entryByLabel("Open File Panel").querySelector("kbd")?.textContent;
    expect(after).not.toBe(before);
    expect(after).toBe(chordLabel(chord({ ctrl: true, alt: true, code: "KeyK" })));
  });

  it("opens the filer, flips the label, and keeps the focused entry mounted", () => {
    mount();
    const filerEntry = entryByLabel("Open File Panel");
    filerEntry.focus();
    expect(document.activeElement).toBe(filerEntry);

    act(() => { filerEntry.click(); });

    expect(useStore.getState().panels.filer).toBe(true);
    expect(entryByLabel("Hide File Panel")).toBeTruthy();
    // The rows are keyed by a stable id, so the label flip re-renders the
    // same button; keying on the label would have dropped the keyboard user's
    // focus to the body here.
    expect(filerEntry.isConnected).toBe(true);
    expect(document.activeElement).toBe(filerEntry);
  });

  it("opens the sender and switches to the workbench view", () => {
    mount();
    act(() => { entryByLabel("Open Sender").click(); });
    expect(useStore.getState().panels.sender).toBe(true);

    act(() => { entryByLabel("Open Workbench").click(); });
    expect(useWorkbench.getState().view).toBe("workbench");
  });
});
