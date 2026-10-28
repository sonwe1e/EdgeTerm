import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { TabStrip } from "../components/TabStrip";
import { useStore, type Tab } from "../store";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
import "../styles.css";

vi.mock("../components/TerminalPane", () => ({ useAccelerator: () => "" }));
const initial = useStore.getState();

beforeEach(async () => {
  await page.viewport(1100, 720);
});

afterEach(async () => {
  await browserAfterEach();
  useStore.getState().setLanguage(initial.language);
  useStore.setState(initial);
});

function fixture() {
  const paneId = initial.activePaneId;
  const tabs: Tab[] = ["main", "api", "web", "docs", "worker"].map((id, index) => ({
    info: {
      id,
      name: id,
      kind: "local",
      protocol: "local",
      profileId: null,
      address: "fixture",
      color: "#4ea1f3",
      supportsRemoteFiles: false,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id, name: id, kind: "local" },
    number: index + 1,
    ordinal: 0,
    state: id === "worker" ? "error" : "connected",
    commandActivity: id === "api" ? "running" : id === "docs" ? "complete" : "idle",
    activityKind: "ai",
    cols: 80,
    rows: 24,
    paneId,
  }));
  useStore.setState({
    ...initial,
    language: "en",
    tabs,
    activeId: "main",
    panes: [{ id: paneId, activeTabId: "main" }],
  });
  mount(
    h(
      "div",
      { className: "pane-stack", style: { width: 400, height: 240 } },
      h(TabStrip, { paneId }),
    ),
  );
}

it("exposes background activity and connection state in tabs and the overflow menu", async () => {
  fixture();
  await twoFrames();
  const api = document.querySelector<HTMLElement>('[data-tab-id="api"]')!;
  expect(api.getAttribute("aria-label")).toContain("Connected");
  expect(api.getAttribute("aria-label")).toContain("AI session active");

  const all = page.getByRole("button", { name: /All sessions.*2 sessions need attention/ });
  const point = pagePoint(document.querySelector(".tab-list-button")!);
  await mouse.press(point.x, point.y);
  await mouse.release(point.x, point.y);
  await twoFrames();
  expect(all.element().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".tab-list-menu")?.textContent).toContain(
    "docs · AI session needs review",
  );
  expect(document.querySelector(".tab-list-menu")?.textContent).toContain("worker · Error");
  await userEvent.click(
    page.getByRole("menuitemradio", { name: /docs · AI session needs review/ }),
  );
  expect(useStore.getState().activeId).toBe("docs");
  expect(useStore.getState().tabs.find((tab) => tab.info.id === "docs")?.commandActivity).toBe(
    "idle",
  );
  expect(document.querySelector('[aria-label*="1 session needs attention"]')).not.toBeNull();
});

it("uses the current interface language for activity and the attention summary", async () => {
  fixture();
  useStore.getState().setLanguage("zh-CN");
  await twoFrames();
  expect(document.querySelector('[data-tab-id="api"]')?.getAttribute("aria-label")).toContain(
    "AI 会话活跃",
  );
  expect(document.querySelector('[data-tab-id="api"]')?.getAttribute("aria-label")).toContain(
    "已连接",
  );
  expect(document.querySelector('[aria-label*="2 个会话需要关注"]')).not.toBeNull();
});

it("keeps keyboard tab navigation and acknowledges a completed turn on selection", async () => {
  fixture();
  document.querySelector<HTMLElement>('[data-tab-id="main"]')!.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(useStore.getState().activeId).toBe("api");
  expect(useStore.getState().tabs.find((tab) => tab.info.id === "api")?.commandActivity).toBe(
    "running",
  );
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  expect(useStore.getState().activeId).toBe("docs");
  expect(useStore.getState().tabs.find((tab) => tab.info.id === "docs")?.commandActivity).toBe(
    "idle",
  );
});

it("keeps a visible static running mark when reduced motion is requested", async () => {
  const session = cdp() as unknown as {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  try {
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    fixture();
    await twoFrames();
    const mark = getComputedStyle(document.querySelector('[data-tab-id="api"]')!, "::after");
    expect(mark.animationName).toBe("none");
    expect(parseFloat(mark.width)).toBeGreaterThan(0);
    expect(parseFloat(mark.height)).toBeGreaterThan(0);
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});
