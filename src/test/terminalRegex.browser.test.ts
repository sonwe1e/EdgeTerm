import { Terminal } from "@xterm/xterm";
import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { SearchOverlay } from "../components/SearchOverlay";
import { TerminalController } from "../terminal";
import { disposeController, setController } from "../terminalRegistry";
import { useStore, type Tab } from "../store";
import { TerminalFind } from "../terminalFind";
import { DEFAULT_FIND_OPTIONS, type SearchResults } from "../terminalSearch";
import { browserAfterEach, mount, wait } from "./browserHarness";
import "../styles.css";

const cleanups: (() => void)[] = [];
const regex = { ...DEFAULT_FIND_OPTIONS, regex: true };

function setup(cols = 80, scrollback = 2000) {
  const host = document.createElement("div");
  host.style.cssText = "width:900px;height:400px";
  document.body.append(host);
  const term = new Terminal({ allowProposedApi: true, cols, rows: 10, scrollback });
  term.open(host);
  const find = new TerminalFind(term, {
    match: "#623315",
    activeMatch: "#9e6a03",
    scope: "#2b2d30",
  });
  const results: SearchResults[] = [];
  find.onResults((value) => results.push(value));
  cleanups.push(() => {
    find.dispose();
    term.dispose();
    host.remove();
  });
  return { term, find, results, last: () => results[results.length - 1] };
}

const write = (term: Terminal, text: string) =>
  new Promise<void>((resolve) => term.write(text, resolve));
afterEach(async () => {
  await browserAfterEach();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("times out a pathological regex without blocking the page, then accepts a new search", async () => {
  const { term, find, last } = setup();
  await write(term, `${"a".repeat(32)}!`);
  let heartbeat = false;
  const pending = find.find("^(a+)+$", regex, true, true);
  setTimeout(() => {
    heartbeat = true;
  }, 0);
  await expect.poll(() => heartbeat).toBe(true);
  expect(last().busy).toBe(true);
  await pending;
  expect(last()).toEqual({ resultCount: 0, resultIndex: -1, error: "timeout" });
  await find.find("a+", regex, true, true);
  expect(last()).toEqual({ resultCount: 1, resultIndex: 0 });
  expect(term.getSelection()).toBe("a".repeat(32));
});

it("cancels superseded searches and closing the search prevents late results", async () => {
  const { term, find, last, results } = setup();
  await write(term, `${"a".repeat(32)}!`);
  const old = find.find("^(a+)+$", regex, true, true);
  await wait(50);
  await find.find("!", regex, true, true);
  await old;
  expect(term.getSelection()).toBe("!");
  expect(last()).toEqual({ resultCount: 1, resultIndex: 0 });
  const closing = find.find("^(a+)+$", regex, true, true);
  find.clear();
  const count = results.length;
  await closing;
  await wait(1600);
  expect(results).toHaveLength(count);
  find.find("!", DEFAULT_FIND_OPTIONS, true, true);
  expect(last()).toEqual({ resultCount: 1, resultIndex: 0 });
});

it("preserves regex anchors, wide characters, wrapping and find-in-selection bounds", async () => {
  const { term, find, last } = setup(10);
  await write(term, "中文 foo foo\r\nfoobar foo");
  await find.find("^中文", regex, true, true);
  expect(term.getSelection()).toBe("中文");
  expect(term.getSelectionPosition()?.end.x).toBe(4);
  await find.find("foo foo$", regex, true, true);
  expect(term.getSelection()).toBe("foo foo");
  term.select(5, 0, 3);
  expect(find.setScope(true)).toBe(true);
  await find.find("foo", regex, true, true);
  expect(last()).toEqual({ resultCount: 1, resultIndex: 0 });
  await find.find("^foo", regex, true, true);
  expect(last().resultCount).toBe(0);
  find.setScope(false);
  await find.find("foo", { ...regex, wholeWord: true }, true, true);
  expect(last().resultCount).toBe(3);
});

it("navigates beyond the highlight limit, backward and forward, without storing every match", async () => {
  const { term, find, last } = setup(80);
  await write(term, Array.from({ length: 1100 }, () => "foo").join("\r\n"));
  term.clearSelection();
  await find.find("foo", regex, false, false);
  expect(last()).toEqual({ resultCount: 1000, resultIndex: -1 });
  expect(term.getSelectionPosition()?.start.y).toBe(1099);
  await find.find("foo", regex, true, false);
  expect(last()).toEqual({ resultCount: 1000, resultIndex: 0 });
  await find.find("foo", regex, true, false);
  expect(term.getSelectionPosition()?.start.y).toBe(1);
  await find.find("foo", regex, false, true);
  expect(term.getSelectionPosition()?.start.y).toBe(1);
  await find.find("foo", regex, false, false);
  expect(term.getSelectionPosition()?.start.y).toBe(0);
});

it("refreshes after output and discards results for a buffer changed while searching", async () => {
  const { term, find, last } = setup();
  await write(term, "foo");
  await find.find("foo", regex, true, true);
  await write(term, "\r\nfoo");
  await expect.poll(() => last().resultCount, { timeout: 2000 }).toBe(2);
  expect(term.getSelectionPosition()?.start.y).toBe(0);
  const pending = find.find("foo", regex, true, true);
  term.reset();
  find.bufferChanged();
  await pending;
  await expect.poll(() => last(), { timeout: 2000 }).toEqual({ resultCount: 0, resultIndex: -1 });
  expect(term.getSelection()).toBe("");
});

it("does not overwrite a selection the user makes while matching", async () => {
  const { term, find } = setup();
  await write(term, "foo bar");
  const pending = find.find("foo", regex, true, true);
  term.select(4, 0, 3);
  await pending;
  expect(term.getSelection()).toBe("bar");
});

it("recomputes plain-text results when regex mode is disabled during a pending search", async () => {
  const { term, find, last } = setup();
  await write(term, "old needle");
  find.find("old", DEFAULT_FIND_OPTIONS, true, true);
  const pending = find.find("needle", regex, true, true);
  find.find("needle", DEFAULT_FIND_OPTIONS, true, true);
  expect(term.getSelection()).toBe("needle");
  await pending;
  expect(term.getSelection()).toBe("needle");
  expect(last()).toEqual({ resultCount: 1, resultIndex: 0 });
});

it("does not include a wrapped wide character outside the selected rows", async () => {
  const { term, find, last } = setup(10);
  await write(term, "123456789中");
  term.select(0, 0, 10);
  expect(find.setScope(true)).toBe(true);
  await find.find("中", regex, true, true);
  expect(last().resultCount).toBe(0);
});

it("bounds highlight registration for one match spanning many wrapped rows", async () => {
  const { term, find } = setup(80);
  await write(term, "a".repeat(40000));
  const registrations = vi.spyOn(term, "registerDecoration");
  try {
    await find.find("^a+$", regex, true, true);
    await wait(50);
    expect(term.getSelection()).toHaveLength(40000);
    // Ten visible rows, painted once before and once after revealing the match.
    expect(registrations.mock.calls.length).toBeLessThanOrEqual(20);
    term.scrollToBottom();
    await wait(50);
    expect(registrations.mock.calls.length).toBeLessThanOrEqual(30);
  } finally {
    registrations.mockRestore();
  }
});

it("shows a timeout in the search box and keeps retry and Escape usable", async () => {
  await page.viewport(900, 600);
  const id = "regex-overlay-fixture";
  const tab: Tab = {
    info: {
      id,
      profileId: null,
      name: id,
      kind: "local",
      protocol: "local",
      address: "",
      color: null,
      supportsRemoteFiles: false,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id, name: id, kind: "local" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: "main",
  };
  useStore.setState({ tabs: [tab], activeId: id, language: "en" });
  const controller = new TerminalController(
    id,
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    100,
  );
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;top:100px;width:850px;height:400px";
  document.body.append(host);
  controller.term.open(host);
  setController(id, controller);
  cleanups.push(() => {
    disposeController(id);
    host.remove();
    useStore.setState({ tabs: [], activeId: null });
  });
  await write(controller.term, `${"a".repeat(32)}!`);
  const mounted = mount(h(SearchOverlay, { onClose: () => mounted.render(null) }));
  await userEvent.click(page.getByRole("button", { name: "Use Regular Expression", exact: true }));
  const input = page.getByRole("search").getByRole("textbox");
  await userEvent.fill(input, "^(a+)+$");
  await expect
    .poll(() => document.querySelector(".search-count")?.textContent, { timeout: 3000 })
    .toBe("Search timed out. Simplify the expression.");
  const box = document.querySelector<HTMLElement>(".terminal-search")!;
  expect(box.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: "../../artifacts/ui-search/regex-timeout.png" });
  await userEvent.fill(input, "a+");
  await expect.poll(() => document.querySelector(".search-count")?.textContent).toBe("1/1");
  await userEvent.fill(input, "^(a+)+$");
  await userEvent.keyboard("{Escape}");
  expect(document.querySelector(".terminal-search")).toBeNull();
});
