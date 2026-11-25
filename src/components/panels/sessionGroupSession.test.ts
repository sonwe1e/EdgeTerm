// Feat/UX: a group's context menu now creates a session inside it. The
// regression: a new session started blank from the panel's own button, so the
// user re-picked the kind, port and group the folder already said.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childGroups, flattenGroups } from "../../sessionGroups";

vi.mock("../../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("../../nativeDialog", () => ({
  ask: vi.fn(async () => true),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  closeSession: vi.fn(async () => {}),
  listSenderCommands: vi.fn(async () => []),
  deleteProfile: vi.fn(async () => {}),
}));

import { useStore } from "../../store";
import type { SessionGroup } from "../../types";
import { newSessionProfile } from "../SessionDialog";
import { SessionPanel } from "./SessionPanel";

const initialState = useStore.getState();
let host: HTMLDivElement;
let root: Root;

const group = (over: Partial<SessionGroup> = {}): SessionGroup => ({
  id: "g1",
  name: "prod",
  kind: "ssh",
  parentId: null,
  ...over,
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState(
    {
      ...initialState,
      language: "en",
      tabs: [],
      activeId: null,
      profiles: [],
      groups: [group()],
      panels: { sessions: true, filer: false, sender: false },
    },
    true,
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("newSessionProfile", () => {
  it("starts a group's session from the group's kind and preselects the group", () => {
    const profile = newSessionProfile(group({ kind: "ssh" }));
    expect(profile.kind).toBe("ssh");
    expect(profile.port).toBe(22);
    expect(profile.groupId).toBe("g1");
    // A fresh profile still has no name; Save validates it.
    expect(profile.name).toBe("");
  });

  it("starts a file-session group on SFTP, the way picking (S)FTP does", () => {
    const profile = newSessionProfile(group({ kind: "ftp" }));
    expect(profile.kind).toBe("sftp");
    expect(profile.port).toBe(22);
    expect(profile.groupId).toBe("g1");
  });

  it("takes the kind's default port and leaves no group outside a folder", () => {
    expect(newSessionProfile(group({ kind: "telnet" })).port).toBe(23);
    const loose = newSessionProfile();
    expect(loose.kind).toBe("ssh");
    expect(loose.groupId).toBeUndefined();
  });
});

describe("group context menu", () => {
  const mount = (onNewSession = vi.fn()) => {
    act(() => {
      root.render(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession }));
    });
    return onNewSession;
  };

  it("offers New Session and hands the panel's callback that group", () => {
    const onNewSession = mount();
    const row = host.querySelector<HTMLElement>('[id^="session-group-"]')!;
    expect(row).toBeTruthy();
    act(() => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24,
        }),
      );
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
      element.textContent?.includes("New Session"),
    );
    expect(item).toBeTruthy();
    act(() => item!.click());
    expect(onNewSession).toHaveBeenCalledWith(expect.objectContaining({ id: "g1", kind: "ssh" }));
  });

  it("keeps the panel's own button creating an ungrouped session", () => {
    const onNewSession = mount();
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.getAttribute("title") === "New session",
    )!;
    act(() => button.click());
    expect(onNewSession).toHaveBeenCalledWith();
  });

  it("keeps groups in a cycle at the kind root instead of dropping them", () => {
    // childGroups walks down from the kind root and only descends through
    // groups whose effective parent is null. Two groups that name each other
    // as parent therefore qualify for neither level, so the folders - and
    // every session filed in them - would vanish from the tree with no empty
    // state and no way to repair them. The rule that already covers a missing
    // parent has to cover a looping one too.
    const cyclic: SessionGroup[] = [
      { id: "a", name: "A", kind: "ssh", parentId: "b" },
      { id: "b", name: "B", kind: "ssh", parentId: "a" },
      { id: "solo", name: "Solo", kind: "ssh", parentId: null },
    ];
    expect(
      childGroups(cyclic, "ssh", null)
        .map((g) => g.id)
        .sort(),
    ).toEqual(["a", "b", "solo"]);
    expect(flattenGroups(cyclic, "ssh").map((n) => n.group.id)).toEqual(["a", "b", "solo"]);
    // A three-step loop is caught the same way as a two-step one.
    const longer: SessionGroup[] = [
      { id: "x", name: "X", kind: "ssh", parentId: "y" },
      { id: "y", name: "Y", kind: "ssh", parentId: "z" },
      { id: "z", name: "Z", kind: "ssh", parentId: "x" },
    ];
    expect(flattenGroups(longer, "ssh").map((n) => n.group.id)).toEqual(["x", "y", "z"]);
  });
});
