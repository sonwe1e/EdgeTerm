import { createElement as h, StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mount, twoFrames } from "../test/browserHarness";
import { ProjectSearch } from "./ProjectSearch";
import { QuickOpen } from "./QuickOpen";
import * as wb from "./api";
import type { SearchResult } from "./types";
import "../styles.css";

vi.mock("./api", () => ({ search: vi.fn() }));

const result = (path: string): SearchResult => ({
  root: "/project",
  query: "needle",
  matches: [{ path, line: 1, text: "needle" }],
  truncated: false,
  skipped: "",
});

beforeEach(async () => {
  vi.mocked(wb.search).mockReset();
  await page.viewport(1000, 700);
});
afterEach(browserAfterEach);

it("finishes project searches and allows retry under StrictMode", async () => {
  vi.mocked(wb.search)
    .mockResolvedValueOnce(result("found.ts"))
    .mockRejectedValueOnce(new Error("offline"));
  mount(
    h(
      StrictMode,
      null,
      h(ProjectSearch, {
        sessionId: "session",
        root: "/project",
        onOpen() {},
        onClose() {},
      }),
    ),
  );
  await userEvent.fill(page.getByRole("textbox"), "needle");
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => document.querySelector(".wb-search-results")?.textContent)
    .toContain("found.ts");
  expect(document.querySelector<HTMLButtonElement>(".wb-search-bar button")!.disabled).toBe(false);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.querySelector(".wb-search-error")?.textContent).toBe("offline");
  expect(document.querySelector<HTMLButtonElement>(".wb-search-bar button")!.disabled).toBe(false);
});

it("ignores an old project's response and releases its busy state", async () => {
  let finish!: (value: SearchResult) => void;
  vi.mocked(wb.search).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const props = { sessionId: "session", root: "/old", onOpen() {}, onClose() {} };
  const mounted = mount(h(ProjectSearch, props));
  await userEvent.fill(page.getByRole("textbox"), "needle");
  await userEvent.keyboard("{Enter}");
  mounted.render(h(ProjectSearch, { ...props, root: "/new" }));
  await twoFrames();
  expect(document.querySelector<HTMLButtonElement>(".wb-search-bar button")!.disabled).toBe(false);
  vi.mocked(wb.search).mockResolvedValueOnce(result("new.ts"));
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => document.querySelector(".wb-search-results")?.textContent)
    .toContain("new.ts");
  finish(result("old.ts"));
  await twoFrames();
  expect(document.querySelector(".wb-search-results")!.textContent).not.toContain("old.ts");
});

it("keeps the keyboard-selected quick-open row visible and opens it", async () => {
  const onOpen = vi.fn();
  const files = Array.from({ length: 80 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`);
  mount(
    h(QuickOpen, {
      files: { root: "/project", source: "fixture", files, truncated: false },
      error: null,
      onRetry() {},
      onOpen,
      onClose() {},
    }),
  );
  await userEvent.keyboard("{ArrowDown>25/}");
  await twoFrames();
  const list = document.querySelector<HTMLElement>(".wb-quickopen-results")!;
  const selected = document.querySelector<HTMLElement>('[aria-selected="true"]')!;
  expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    list.getBoundingClientRect().bottom + 1,
  );
  expect(list.scrollTop).toBeGreaterThan(0);
  await page.screenshot({ path: "../../artifacts/ui-search/quick-open-keyboard.png" });
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledWith(files[25]);
});

it("keeps the first result selectable after ArrowDown while files load", async () => {
  const onOpen = vi.fn();
  const props = { files: null, error: null, onRetry() {}, onOpen, onClose() {} };
  const mounted = mount(h(QuickOpen, props));
  await userEvent.keyboard("{ArrowDown}");
  mounted.render(
    h(QuickOpen, {
      ...props,
      files: { root: "/project", source: "fixture", files: ["ready.ts"], truncated: false },
    }),
  );
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledWith("ready.ts");
});
