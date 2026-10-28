import { createElement as h, type CSSProperties } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
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
      h(Workspace, { onNewSession: vi.fn() }),
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
