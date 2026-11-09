import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { TabStrip } from "../components/TabStrip";
import { useAgents } from "../agents/model";
import { useStore, type Tab } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

vi.mock("../components/TerminalPane", () => ({ useAccelerator: () => "" }));
const initial = useStore.getState();
const initialAgents = useAgents.getState();

afterEach(async () => {
  await browserAfterEach();
  useStore.getState().setLanguage(initial.language);
  useStore.setState(initial, true);
  useAgents.setState(initialAgents, true);
});

async function fixture(width: number) {
  await page.viewport(900, 560);
  const paneId = initial.activePaneId;
  const tabs: Tab[] = ["Local Shell", "build-box", "worker", "docs", "queue"].map(
    (name, index) => ({
      info: {
        id: `agent-tab-${index}`,
        name,
        kind: "local",
        protocol: "local",
        profileId: null,
        address: "fixture",
        color: null,
        supportsRemoteFiles: false,
        recording: null,
        legacyAlgorithms: [],
        sharedConnection: false,
      },
      profile: { id: name, name, kind: "local" },
      number: index + 1,
      // Every distinct ad-hoc session is its first instance. Ordinal counts
      // duplicate opens of the same session, not its position in this strip.
      ordinal: 0,
      state: "connected",
      commandActivity: "idle",
      activityKind: "command",
      cols: 80,
      rows: 24,
      paneId,
    }),
  );
  useStore.setState({
    ...initial,
    language: "en",
    tabs,
    activeId: tabs[0].info.id,
    panes: [{ id: paneId, activeTabId: tabs[0].info.id }],
  });
  useAgents.setState({
    ...initialAgents,
    recognized: {},
    senderAgentMode: false,
    composeRequest: 0,
  });
  mount(
    h(
      "div",
      { className: "app" },
      h(
        "div",
        { className: "workspace", style: { width, height: 180, flex: "none" } },
        h(
          "div",
          { className: "pane is-focused", style: { inset: 0 } },
          h(TabStrip, { paneId }),
          h("div", { className: "pane-stack", "data-pane-id": paneId }),
        ),
      ),
    ),
  );
  await twoFrames();
  const strip = document.querySelector<HTMLElement>(".tabstrip")!;
  expect(strip.clientWidth).toBe(width);
  expect(strip.getBoundingClientRect().height).toBe(30);
  return document.querySelector<HTMLElement>(".workspace")!;
}

it("keeps the prompt action accessible and a second session title readable in a narrow strip", async () => {
  await fixture(380);
  const button = page.getByRole("button", { name: "Agent prompt", exact: true });
  const element = button.element() as HTMLButtonElement;
  expect(element.getBoundingClientRect().width).toBeLessThanOrEqual(32);
  expect(element.getAttribute("title")).toBe("Agent prompt");
  expect(element.getAttribute("aria-label")).toBe("Agent prompt");
  const actions = document.querySelector<HTMLElement>(".tabstrip-actions")!.getBoundingClientRect();
  const secondTitle = document.querySelector<HTMLElement>(
    '[data-tab-id="agent-tab-1"] .tab-label',
  )!;
  expect(secondTitle.textContent).toBe("build-box");
  expect(secondTitle.getBoundingClientRect().right).toBeLessThanOrEqual(actions.left);
  await userEvent.click(button);
  expect(useStore.getState().activeId).toBe("agent-tab-0");
  expect(useAgents.getState().senderAgentMode).toBe(true);
  expect(useAgents.getState().composeRequest).toBe(1);
  await page.screenshot({
    path: "./__screenshots__/agentTabActions.browser.test.ts/agent-tabs-380.png",
  });
});

it("restores the wide prompt label using pane width, without an overflow feedback loop", async () => {
  const workspace = await fixture(600);
  for (const width of [600, 380, 600, 380]) {
    workspace.style.width = `${width}px`;
    await twoFrames();
    expect(document.querySelector<HTMLElement>(".tabstrip")!.clientWidth).toBe(width);
    const button = document.querySelector<HTMLElement>(".agent-compose-launch")!;
    const label = button.querySelector<HTMLElement>(".agent-compose-label")!;
    expect(label).not.toBeNull();
    expect(getComputedStyle(label).display === "none").toBe(width <= 520);
    if (width <= 520) expect(button.getBoundingClientRect().width).toBeLessThanOrEqual(32);
    else expect(button.getBoundingClientRect().width).toBeGreaterThan(60);
    const settled = button.getBoundingClientRect().width;
    await twoFrames();
    expect(button.getBoundingClientRect().width).toBe(settled);
  }
});
