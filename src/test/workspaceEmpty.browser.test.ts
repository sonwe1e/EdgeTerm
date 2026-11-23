import { createElement as h, type CSSProperties } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Workspace } from "../components/Workspace";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const initialState = useStore.getState();

afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initialState, true);
});

it("keeps the empty workspace reachable at large type in a narrow pane", async () => {
  useStore.setState({
    language: "en",
    tabs: [],
    activeId: null,
    panels: { sessions: true, filer: true, sender: true },
  });
  // This is the pane measured at the 900×560 desktop minimum with docks on
  // both sides and the supported 18px panel font, not a viewport breakpoint.
  mount(
    h(
      "div",
      {
        className: "app",
        style: { width: 378, height: 465, "--panel-font-size": "18px" } as CSSProperties,
      },
      h(Workspace, { onNewSession: vi.fn(), onSaveSession: vi.fn(), onOpenProfile: vi.fn() }),
    ),
  );
  await twoFrames();

  const pane = document.querySelector<HTMLElement>(".pane-stack")!;
  const mark = document.querySelector<HTMLElement>(".term-empty-icon")!;
  const entries = [...document.querySelectorAll<HTMLButtonElement>(".term-empty-entry")];
  const lastEntry = entries[entries.length - 1];
  expect(mark.getBoundingClientRect().top).toBeGreaterThanOrEqual(pane.getBoundingClientRect().top);

  entries[entries.length - 2].focus();
  await userEvent.keyboard("{Tab}");
  await twoFrames();
  const visible = pane.getBoundingClientRect();
  const entry = lastEntry.getBoundingClientRect();
  expect(document.activeElement).toBe(lastEntry);
  expect(entry.top).toBeGreaterThanOrEqual(visible.top - 1);
  // The focus ring is 2px wide with a 2px offset; allow it room as well.
  expect(entry.bottom).toBeLessThanOrEqual(visible.bottom - 3);
});

it("offers the sessions used last as the way back in", async () => {
  // A full window: the empty state's entry list is taller than the minimum
  // pane this file's other case measures, and a clipped button cannot be hit.
  await page.viewport(1024, 768);
  const onOpenProfile = vi.fn();
  const profile = { id: "p1", name: "Lab box", kind: "ssh", host: "lab.invalid" } as never;
  useStore.setState({
    language: "en",
    tabs: [],
    activeId: null,
    profiles: [profile],
    recentProfiles: ["p1"],
    panels: { sessions: true, filer: false, sender: false },
  });
  mount(
    h(
      "div",
      { className: "app", style: { width: 900, height: 640 } as CSSProperties },
      h(Workspace, { onNewSession: vi.fn(), onSaveSession: vi.fn(), onOpenProfile }),
    ),
  );
  await twoFrames();

  const recent = document.querySelector<HTMLButtonElement>('[aria-label="Open Lab box"]');
  expect(recent, "the recent session is offered in the empty window").not.toBeNull();
  expect(recent!.textContent, "and says what it is").toContain("Recent session");
  await userEvent.click(recent!);
  expect(onOpenProfile).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
});
