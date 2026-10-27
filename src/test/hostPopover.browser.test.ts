import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { HostStrip } from "../workbench/HostStrip";
import { useWorkbench } from "../workbench/store";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const fixtureSamples = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../workbench/hostSampling", () => ({
  useHostSampling: () => {},
  useHostSamples: Object.assign(
    (selector: (state: { samples: object }) => unknown) =>
      selector({ samples: fixtureSamples.current }),
    { getState: () => ({ samples: fixtureSamples.current }) },
  ),
}));
const initial = useWorkbench.getState();
beforeEach(async () => {
  fixtureSamples.current = {};
  await page.viewport(1100, 720);
  useStore.setState({ language: "en" });
  useWorkbench.setState({
    data: {
      experiments: [],
      runs: [],
      workspaces: ["one", "two"].map((id) => ({
        id,
        name: id,
        server: { profileId: id, name: id, host: id, port: 22, username: "dev" },
        root: "/fixture",
        env: "",
        commands: [],
        runRoot: "/fixture",
        baselineExperimentId: null,
        createdAt: 0,
        updatedAt: 0,
      })),
    },
  });
});

it("distinguishes a zero network rate from an unavailable reading", async () => {
  fixtureSamples.current = {
    "dev@one:22": {
      at: Date.now(),
      metrics: { networkReceiveBps: 0, networkSendBps: null, gpuStatus: "unsupported", gpus: [] },
      history: [],
    },
  };
  const triggers = fixture();
  await userEvent.click(triggers[0]);
  expect(document.querySelector(".wb-host-detail")!.textContent).toContain("↓0 B/s · ↑—/s");
});
afterEach(async () => {
  await browserAfterEach();
  useWorkbench.setState(initial);
});

function fixture() {
  mount(
    h(
      "div",
      { className: "app" },
      h(HostStrip),
      h("button", { id: "outside", style: { position: "absolute", top: 500 } }, "Outside"),
    ),
  );
  return [...document.querySelectorAll<HTMLButtonElement>(".wb-host-chip")];
}

it("Escape dismisses the second host and restores its own trigger", async () => {
  const triggers = fixture();
  await userEvent.click(triggers[1]);
  await userEvent.keyboard("{Escape}");
  expect(document.querySelector(".wb-host-popover")).toBeNull();
  expect(document.activeElement).toBe(triggers[1]);
  expect(triggers[1].getAttribute("aria-expanded")).toBe("false");
});

it("dismisses on an outside click while preserving the clicked control's focus", async () => {
  const triggers = fixture();
  await userEvent.click(triggers[0]);
  await userEvent.click(document.querySelector("#outside")!);
  expect(document.querySelector(".wb-host-popover")).toBeNull();
  expect(document.activeElement?.id).toBe("outside");
});

it("keeps inside clicks open and returns focus on explicit close", async () => {
  const triggers = fixture();
  await userEvent.click(triggers[0]);
  await userEvent.click(document.querySelector(".wb-host-detail strong")!);
  await twoFrames();
  expect(document.querySelector(".wb-host-popover")).not.toBeNull();
  await userEvent.click(document.querySelector(".wb-host-popover button")!);
  expect(document.activeElement).toBe(triggers[0]);
  expect(document.querySelector(".wb-host-popover")).toBeNull();
});
