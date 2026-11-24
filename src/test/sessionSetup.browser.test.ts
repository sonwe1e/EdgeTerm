import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import { SessionDialog } from "../components/SessionDialog";
import { useStore } from "../store";
import type { SessionProfile } from "../types";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  defaultRecordingDir: vi.fn(async () => "C:/recordings"),
  listSerialPorts: vi.fn(async () => []),
  openSession: vi.fn(async () => {
    throw new Error("Connection refused");
  }),
}));
vi.mock("../credentialStatus", async (original) => ({
  ...(await original<typeof import("../credentialStatus")>()),
  fetchCredentialStoreStatus: vi.fn(async () => null),
}));
const initial = useStore.getState();
const save = vi.fn(async (profile: SessionProfile) => ({ ...profile, id: "saved" }));
beforeEach(() => {
  useStore.setState({ ...initial, upsertProfile: save });
  useStore.getState().setLanguage("en");
  save.mockClear();
});

it("retries a failed draft without creating another profile or tab", async () => {
  mount(
    h(SessionDialog, {
      initial: { id: "", name: "", kind: "ftp", host: "fixture.invalid", username: "tester" },
      onClose: vi.fn(),
    }),
  );
  const connect = () => document.querySelector<HTMLButtonElement>(".dialog-footer .is-primary")!;
  await userEvent.click(connect());
  await expect.poll(() => connect().disabled).toBe(false);
  expect(useStore.getState().tabs).toHaveLength(1);
  await userEvent.click(connect());
  await expect.poll(() => save.mock.calls.length).toBe(2);
  await expect.poll(() => connect().disabled).toBe(false);
  expect(save.mock.calls[1][0].id).toBe("saved");
  expect(useStore.getState().tabs).toHaveLength(1);
});
it("will not close the form while the connection it started is running", async () => {
  const { openSession } = await import("../api");
  // A connection that never settles is the state the × used to dismiss.
  vi.mocked(openSession).mockReturnValue(new Promise(() => {}));
  const close = vi.fn();
  mount(
    h(SessionDialog, {
      initial: { id: "", name: "", kind: "ftp", host: "fixture.invalid", username: "tester" },
      onClose: close,
    }),
  );
  const connect = () => document.querySelector<HTMLButtonElement>(".dialog-footer .is-primary")!;
  await userEvent.click(connect());
  await expect.poll(() => connect().disabled, { timeout: 3000 }).toBe(true);
  await userEvent.click(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!);
  expect(close, "the × must not dismiss a running connection").not.toHaveBeenCalled();
});

it("points at the file transfer port when it is out of range", async () => {
  mount(
    h(SessionDialog, {
      initial: {
        id: "",
        name: "",
        kind: "ftp",
        host: "fixture.invalid",
        username: "tester",
        port: 70000,
      },
      onClose: vi.fn(),
    }),
  );
  const connect = () => document.querySelector<HTMLButtonElement>(".dialog-footer .is-primary")!;
  await userEvent.click(connect());
  const port = document.querySelector<HTMLInputElement>('[data-field="port"]')!;
  // The message names the port; the caret has to land on the field it is about,
  // the way host, locale and baud already do.
  await expect.poll(() => document.activeElement === port, { timeout: 3000 }).toBe(true);
  expect(port.getAttribute("aria-invalid"), "the field is marked too").toBe("true");
});

it("keeps every hop of a jump chain in the order it was added", async () => {
  const bastion = {
    id: "hop-a",
    name: "bastion",
    kind: "ssh" as const,
    host: "10.0.0.1",
    username: "gate",
    port: 22,
  };
  const gateway = {
    id: "hop-b",
    name: "gateway",
    kind: "ssh" as const,
    host: "10.0.0.2",
    username: "gate",
    port: 22,
  };
  useStore.setState({ profiles: [bastion, gateway] });
  mount(
    h(SessionDialog, {
      initial: { id: "", name: "db", kind: "ssh", host: "db.internal", username: "app" },
      onClose: vi.fn(),
    }),
  );
  await twoFrames();
  await userEvent.click(document.querySelector<HTMLElement>(".session-advanced > summary")!);
  const add = () => document.querySelector<HTMLSelectElement>('[aria-label="Add a jump host…"]')!;
  await userEvent.selectOptions(add(), "hop-a");
  await twoFrames();
  await userEvent.selectOptions(add(), "hop-b");
  await twoFrames();
  // The order is the path the tunnel is opened in, so it is what the form
  // shows and what the profile stores.
  expect(
    [...document.querySelectorAll(".session-jump-name")].map((node) => node.textContent),
  ).toEqual(["bastion — gate@10.0.0.1:22", "gateway — gate@10.0.0.2:22"]);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".dialog-footer .is-primary")!);
  await expect.poll(() => save.mock.calls.length, { timeout: 4000 }).toBe(1);
  expect(save.mock.calls[0][0].jumpProfileIds, "both hops, in order").toEqual(["hop-a", "hop-b"]);
});

afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial, true);
  useStore.getState().setLanguage(initial.language);
  document.documentElement.removeAttribute("data-theme");
});

for (const [width, height] of [
  [1100, 720],
  [900, 560],
]) {
  it(`puts connection fields before optional organization at ${width} × ${height}`, async () => {
    await page.viewport(width, height);
    document.documentElement.dataset.theme = "light";
    const close = vi.fn();
    mount(h(SessionDialog, { initial: null, onClose: close }));
    await twoFrames();
    const host = document.querySelector<HTMLInputElement>('[data-field="host"]')!;
    expect(document.activeElement).toBe(host);
    expect(document.querySelector<HTMLDetailsElement>(".session-organization")!.open).toBe(false);
    await userEvent.fill(host, "fixture.invalid");
    await userEvent.fill(page.getByRole("textbox", { name: "Username", exact: true }), "tester");
    expect(host.getBoundingClientRect().bottom).toBeLessThan(
      document.querySelector(".dialog-footer")!.getBoundingClientRect().top,
    );
    await page.screenshot({ path: `../../artifacts/usability/session-${width}.png` });
    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await expect.poll(() => save.mock.calls.length).toBe(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      host: "fixture.invalid",
      username: "tester",
      kind: "ssh",
    });
    expect(close).toHaveBeenCalledOnce();
  });
}

it("keeps existing organization editable and focuses visible local and serial fields", async () => {
  const surface = mount(
    h(SessionDialog, {
      initial: { id: "saved", name: "Lab", kind: "ssh", host: "fixture", username: "tester" },
      onClose: vi.fn(),
    }),
  );
  expect(document.querySelector<HTMLDetailsElement>(".session-organization")!.open).toBe(true);
  const name = document.querySelector<HTMLInputElement>('[data-field="name"]')!;
  await userEvent.fill(name, "New lab");
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  expect(save.mock.calls[0][0].name).toBe("New lab");
  for (const [kind, field] of [
    ["local", "shell"],
    ["serial", "serialPort"],
  ] as const) {
    surface.render(
      h(SessionDialog, { key: kind, initial: { id: "", name: "", kind }, onClose: vi.fn() }),
    );
    await twoFrames();
    expect(document.activeElement).toBe(document.querySelector(`[data-field="${field}"]`));
  }
});
