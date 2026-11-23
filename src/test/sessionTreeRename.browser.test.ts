import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import { SessionPanel } from "../components/panels/SessionPanel";
import { useStore } from "../store";
import type { SessionProfile } from "../types";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  listSessions: vi.fn(async () => []),
  localHome: vi.fn(async () => "/tmp"),
  localList: vi.fn(async (path: string) => ({ path, entries: [] })),
}));

const initial = useStore.getState();
const profile = {
  id: "p1",
  name: "Lab box",
  kind: "ssh",
  host: "lab.invalid",
  port: 22,
  username: "tester",
  auth: "password",
  keyPath: null,
  password: null,
  encoding: "utf-8",
  backspace: "del",
  groupId: null,
  color: null,
  startupCommand: null,
  proxyJump: null,
  keepaliveSeconds: 0,
} as unknown as SessionProfile;

beforeEach(() => {
  useStore.getState().setLanguage("en");
  useStore.setState({ ...initial, profiles: [profile], groups: [], tabs: [], activeId: null });
});
afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial, true);
});

it("marks the session that was connected to recently", async () => {
  // The fixture's state reset restores the stored language, so the mark is
  // matched by its two possible labels rather than by one locale's title.
  const mark = () =>
    [...document.querySelectorAll<HTMLElement>(".row-meta")].find(
      (element) => element.textContent === "Recent" || element.textContent === "最近",
    ) ?? null;
  mount(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
  await twoFrames();
  expect(mark(), "nothing is marked before a connection").toBeNull();

  // Connecting writes the id into the store; the mounted tree follows it.
  useStore.setState({ recentProfiles: ["p1"] });
  await twoFrames();
  expect(mark(), "the row says it is a recent one").not.toBeNull();
  expect(mark()!.title.length, "and explains itself on hover").toBeGreaterThan(0);
  expect(mark()!.closest(".row")?.textContent, "the mark sits on the profile row").toContain(
    "Lab box",
  );
});

it("renames the item the cursor is on with F2", async () => {
  const onEditProfile = vi.fn();
  mount(h(SessionPanel, { onEditProfile, onNewSession: vi.fn() }));
  await twoFrames();
  const tree = document.querySelector<HTMLElement>('[role="tree"]')!;
  expect(tree, "the session tree is on screen").not.toBeNull();
  tree.focus();
  await twoFrames();
  // Focus lands on the first row (a kind heading); walk down to the profile.
  const activeLabel = () => {
    const id = tree.getAttribute("aria-activedescendant");
    return id ? (document.getElementById(id)?.textContent ?? "") : "";
  };
  for (let step = 0; step < 6 && !activeLabel().includes("Lab box"); step++) {
    await userEvent.keyboard("{ArrowDown}");
    await twoFrames();
  }
  expect(activeLabel(), "the cursor reached the profile").toContain("Lab box");
  await userEvent.keyboard("{F2}");
  await twoFrames();
  expect(onEditProfile).toHaveBeenCalledOnce();
  expect((onEditProfile.mock.calls[0][0] as SessionProfile).id).toBe("p1");
});

it("opens the tree's filter with the slash key and clears it with Escape", async () => {
  mount(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
  await twoFrames();
  const tree = document.querySelector<HTMLElement>('[role="tree"]')!;
  tree.focus();
  await twoFrames();
  await userEvent.keyboard("/");
  await twoFrames();
  const filter = document.querySelector<HTMLInputElement>(".panel-filter input")!;
  expect(document.activeElement, "slash lands in the filter").toBe(filter);

  await userEvent.keyboard("zzz");
  await twoFrames();
  expect(filter.value).toBe("zzz");
  expect(
    [...document.querySelectorAll('[role="treeitem"]')].some((row) =>
      row.textContent?.includes("Lab box"),
    ),
    "a filter that matches nothing hides the session",
  ).toBe(false);

  await userEvent.keyboard("{Escape}");
  await twoFrames();
  expect(filter.value, "Escape clears the filter first").toBe("");
  expect(
    [...document.querySelectorAll('[role="treeitem"]')].some((row) =>
      row.textContent?.includes("Lab box"),
    ),
    "the session is back",
  ).toBe(true);
});
