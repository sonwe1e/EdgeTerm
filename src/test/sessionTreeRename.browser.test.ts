import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
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

it("keeps the mark visible beside a long name at a narrow width", async () => {
  await page.viewport(320, 700);
  const long = {
    ...profile,
    name: "A very long session name that would take the whole row if it could",
  } as SessionProfile;
  useStore.setState({ ...initial, profiles: [long], groups: [], tabs: [], activeId: null });
  mount(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
  await twoFrames();
  useStore.setState({ recentProfiles: ["p1"] });
  await twoFrames();

  const mark = [...document.querySelectorAll<HTMLElement>(".row-meta")].find(
    (element) => element.textContent === "Recent" || element.textContent === "最近",
  );
  expect(mark, "the mark is rendered").toBeTruthy();
  const row = mark!.closest<HTMLElement>(".row")!;
  const markBox = mark!.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  // A mark squeezed to nothing is not a mark: the name must ellipsize first.
  expect(markBox.width, "the mark keeps its width").toBeGreaterThan(12);
  expect(markBox.right, "and stays inside the row").toBeLessThanOrEqual(rowBox.right + 0.5);
});

it("names its own keys for assistive technology", async () => {
  mount(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
  await twoFrames();
  const tree = document.querySelector<HTMLElement>('[role="tree"]')!;
  // F2 and Space are this app's own; the arrows come with the tree pattern.
  expect(tree.getAttribute("aria-keyshortcuts")).toBe("F2 Space");
  const filter = document.querySelector<HTMLInputElement>(".panel-filter input")!;
  expect(filter.getAttribute("aria-keyshortcuts"), "and the filter names /").toBe("/");
});

it("keeps Space for collapsing the heading under the cursor", async () => {
  mount(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
  await twoFrames();
  const tree = document.querySelector<HTMLElement>('[role="tree"]')!;
  tree.focus();
  await twoFrames();
  const section = () => document.querySelector<HTMLElement>('[role="treeitem"][aria-level="1"]')!;
  expect(section().getAttribute("aria-expanded")).toBe("true");
  // Space is a printable character, but it belongs to the row toggle the tree
  // already had; type-ahead must not swallow it.
  await userEvent.keyboard(" ");
  await twoFrames();
  expect(section().getAttribute("aria-expanded"), "Space still collapses the heading").toBe(
    "false",
  );
});

it("finds a session by the group it lives in", async () => {
  mount(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
  await twoFrames();
  // Set after mounting: the panel reads the store live, and a value written
  // before a mount is the one thing this suite has been bitten by.
  useStore.setState({
    groups: [{ id: "g-vault", name: "Vault", kind: "ssh", parentId: null }],
    profiles: [{ ...profile, groupId: "g-vault" }],
  });
  await twoFrames();
  const input = document.querySelector<HTMLInputElement>(".panel-filter input")!;
  const named = () =>
    [...document.querySelectorAll(".row-label")].some((row) => row.textContent === "Lab box");
  await userEvent.type(input, "vault");
  await twoFrames();
  expect(named(), "the group on the path brings the session back").toBe(true);
  await userEvent.clear(input);
  await userEvent.type(input, "vault-zzz");
  await twoFrames();
  expect(named(), "text matching no group hides it").toBe(false);
});

it("finds a session by its host, not only by its name", async () => {
  mount(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
  await twoFrames();
  const input = document.querySelector<HTMLInputElement>(".panel-filter input")!;
  const named = () =>
    [...document.querySelectorAll(".row-label")].some((row) => row.textContent === "Lab box");
  // The fixture's host is "lab.invalid": the name does not contain it.
  await userEvent.type(input, "lab.inv");
  await twoFrames();
  expect(named(), "the host brings the session back").toBe(true);
  await userEvent.clear(input);
  await userEvent.type(input, "lab.inv-zzz");
  await twoFrames();
  expect(named(), "text that matches nothing hides it").toBe(false);
});

it("walks to a session when its first letter is typed", async () => {
  mount(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
  await twoFrames();
  const tree = document.querySelector<HTMLElement>('[role="tree"]')!;
  tree.focus();
  await twoFrames();
  // Focus lands on the kind heading; the letter names the session, not a
  // heading, and no page scroll is attempted because the key is claimed.
  await userEvent.keyboard("l");
  await twoFrames();
  expect(tree.getAttribute("aria-activedescendant")).toBe("session-row-p1");
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
