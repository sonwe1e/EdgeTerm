import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mount } from "./browserHarness";
import { WorkspaceDialog } from "../workbench/WorkspaceDialog";
import { useStore } from "../store";
import type { SessionProfile } from "../types";
import "../styles.css";

vi.mock("../nativeDialog", async (original) => ({
  ...(await original<typeof import("../nativeDialog")>()),
  ask: vi.fn(async () => false),
}));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  defaultRecordingDir: vi.fn(async () => "C:/recordings"),
  listSerialPorts: vi.fn(async () => []),
}));
vi.mock("../credentialStatus", async (original) => ({
  ...(await original<typeof import("../credentialStatus")>()),
  fetchCredentialStoreStatus: vi.fn(async () => null),
}));
const initial = useStore.getState();
beforeEach(() => {
  useStore.setState({ ...initial, profiles: [] });
  useStore.getState().setLanguage("en");
});
afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial, true);
  useStore.getState().setLanguage(initial.language);
});

it("keeps a dirty project form when discarding is declined", async () => {
  const close = vi.fn();
  mount(h(WorkspaceDialog, { workspace: null, onClose: close, onSubmit: vi.fn() }));
  await userEvent.fill(document.querySelector<HTMLInputElement>(".wb-form input")!, "my project");
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>(".wb-form input")!.value).toBe("my project");
});

it("offers server creation inside the first project form", () => {
  mount(h(WorkspaceDialog, { workspace: null, onClose: vi.fn(), onSubmit: vi.fn() }));
  expect(page.getByRole("button", { name: "Add SSH server" }).elements()).toHaveLength(1);
});

it("returns from saving a new server with the project entries intact and the new server selected", async () => {
  useStore.setState({
    upsertProfile: async (draft: SessionProfile) => {
      const saved = { ...draft, id: "new-server" };
      useStore.setState({ profiles: [saved] });
      return saved;
    },
  });
  mount(h(WorkspaceDialog, { workspace: null, onClose: vi.fn(), onSubmit: vi.fn() }));
  await userEvent.fill(document.querySelector<HTMLInputElement>(".wb-form input")!, "kept project");
  await userEvent.fill(
    document.querySelector<HTMLInputElement>('input[placeholder="/data/vfi/baseline"]')!,
    "/work/project",
  );
  await userEvent.click(page.getByRole("button", { name: "Add SSH server" }));
  await expect.poll(() => document.querySelector('[data-field="host"]')).not.toBeNull();
  await userEvent.fill(
    document.querySelector<HTMLInputElement>('[data-field="host"]')!,
    "lab.invalid",
  );
  await userEvent.fill(page.getByRole("textbox", { name: "Username", exact: true }), "tester");
  await userEvent.click(
    document.querySelector<HTMLButtonElement>(
      ".session-dialog .dialog-footer button:nth-child(2)",
    )!,
  );
  await expect.poll(() => document.querySelector(".session-dialog")).toBeNull();
  expect(document.querySelector<HTMLInputElement>(".wb-form input")!.value).toBe("kept project");
  expect(
    document.querySelector<HTMLInputElement>('input[placeholder="/data/vfi/baseline"]')!.value,
  ).toBe("/work/project");
  expect(document.querySelector<HTMLSelectElement>(".wb-form select")!.value).toBe("new-server");
});
