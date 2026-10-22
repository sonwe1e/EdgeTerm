// PD-04 — port forwards carried in an OpenSSH config were written into the
// saved session and started on the next connect with nothing in the interface
// saying so: the import list had no forwards column, the summary counted only
// sessions and jump hosts, and no surface could view, edit or remove a
// profile's rules (a remote forward exposes a port on the server side). The
// regression: the import dialog names them before they start, the session
// dialog manages them, and both speak the tunnel popover's own field rules.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("../nativeDialog", () => ({ ask: vi.fn(async () => true), open: vi.fn(), save: vi.fn() }));
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  importSshConfig: vi.fn(async () => ({ added: 2, updated: 0, jumpHosts: 0, jumpsIgnored: 0, warnings: [] })),
  listSenderCommands: vi.fn(async () => []),
  listSerialPorts: vi.fn(async () => []),
  defaultRecordingDir: vi.fn(async () => "C:/recordings"),
}));

import * as api from "../api";
import * as nativeDialog from "../nativeDialog";
import { useStore } from "../store";
import type { PortForwardSpec, SessionProfile } from "../types";
import { SessionDialog } from "./SessionDialog";
import { SshConfigImportDialog } from "./SshConfigImportDialog";

const initialState = useStore.getState();
let host: HTMLDivElement;
let root: Root;

const forwards: PortForwardSpec[] = [
  { direction: "local", listenHost: "127.0.0.1", listenPort: 8080, targetHost: "db.internal", targetPort: 5432 },
  { direction: "remote", listenHost: "127.0.0.1", listenPort: 9090, targetHost: "web.internal", targetPort: 80 },
];

const preview = {
  path: "C:/Users/dev/.ssh/config",
  entries: [
    { alias: "web", host: "10.0.1.11", port: 22, username: "deploy", auth: "password" as const, jumps: [] as string[], forwards },
    { alias: "ftp", host: "logs.example.com", port: 22, username: "anonymous", auth: "password" as const, jumps: [] as string[] },
  ],
};

const mount = (node: ReturnType<typeof h>) => act(() => { root.render(node); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({ ...initialState, language: "en", profiles: [], groups: [], tabs: [] }, true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("OpenSSH import dialog — the forwards column (PD-04)", () => {
  it("names every forward the selection will start, and dashes the rest", () => {
    mount(h(SshConfigImportDialog, { preview, onClose: vi.fn() }));
    // The column header is a cell too; the entry rows are the ones that count.
    const cells = [...host.querySelectorAll<HTMLElement>(".ssh-import-row:not(.is-head) .ssh-import-forwards")];
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toContain("L 127.0.0.1:8080 → db.internal:5432");
    expect(cells[0].textContent).toContain("R 127.0.0.1:9090 → web.internal:80");
    expect(cells[1].textContent?.trim()).toBe("—");
  });

  it("warns that the selected forwards start on connect, and drops the warning with them", () => {
    mount(h(SshConfigImportDialog, { preview, onClose: vi.fn() }));
    const hints = () => [...host.querySelectorAll<HTMLElement>(".confirm-dialog-hint")]
      .map((element) => element.textContent ?? "");
    expect(hints().some((text) => /start automatically/i.test(text))).toBe(true);

    // Unchecking the host that carries them takes the warning with it.
    const webRow = [...host.querySelectorAll<HTMLElement>(".ssh-import-row")]
      .find((row) => row.textContent?.includes("web"))!;
    act(() => { webRow.querySelector<HTMLInputElement>("input[type='checkbox']")!.click(); });
    expect(hints().some((text) => /start automatically/i.test(text))).toBe(false);
  });

  it("reports the forward count with the import result", async () => {
    const setStatus = vi.spyOn(useStore.getState(), "setStatus");
    mount(h(SshConfigImportDialog, { preview, onClose: vi.fn() }));
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".dialog-footer .btn.is-primary")!.click();
    });
    expect(api.importSshConfig).toHaveBeenCalledWith(preview.path, ["web", "ftp"], null);
    expect(setStatus).toHaveBeenCalledWith(expect.stringContaining("2 port forwards"));
  });
});

describe("Session dialog — port forward management (PD-04)", () => {
  const profile: SessionProfile = {
    id: "p1", name: "web-prod-01", kind: "ssh", host: "10.0.1.11", port: 22,
    username: "deploy", auth: "password", forwards,
  };

  it("lists the saved rules with their routes", () => {
    mount(h(SessionDialog, { initial: profile, onClose: vi.fn() }));
    const rows = [...host.querySelectorAll<HTMLElement>(".session-forward-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".session-forward-badge")?.textContent).toBe("L");
    expect(rows[0].querySelector(".session-forward-route")?.textContent)
      .toContain("127.0.0.1:8080 → db.internal:5432");
    expect(rows[1].querySelector(".session-forward-badge")?.textContent).toBe("R");
  });

  it("removes a rule only behind the confirmation that names its route", async () => {
    mount(h(SessionDialog, { initial: profile, onClose: vi.fn() }));
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".session-forward-remove")!.click();
    });
    expect(nativeDialog.ask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(nativeDialog.ask).mock.calls[0][0]).toContain("db.internal:5432");
    expect(host.querySelectorAll(".session-forward-row")).toHaveLength(1);
  });

  it("adds a rule through the tunnel popover's own validation", async () => {
    mount(h(SessionDialog, { initial: profile, onClose: vi.fn() }));
    const form = host.querySelector<HTMLFormElement>(".session-forwards-form")!;
    const type = (input: HTMLInputElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type(form.querySelector<HTMLInputElement>('[aria-label="Tunnel listener host"]')!, "0.0.0.0");
    type(form.querySelector<HTMLInputElement>('[aria-label="Tunnel listener port"]')!, "1080");
    type(form.querySelector<HTMLInputElement>('[aria-label="Tunnel target host"]')!, "proxy.internal");
    type(form.querySelector<HTMLInputElement>('[aria-label="Tunnel target port"]')!, "3128");
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(host.querySelectorAll(".session-forward-row")).toHaveLength(3);
  });

  it("refuses a rule with no target, the way the tunnel popover does", async () => {
    mount(h(SessionDialog, { initial: profile, onClose: vi.fn() }));
    const form = host.querySelector<HTMLFormElement>(".session-forwards-form")!;
    const type = (input: HTMLInputElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type(form.querySelector<HTMLInputElement>('[aria-label="Tunnel listener host"]')!, "0.0.0.0");
    type(form.querySelector<HTMLInputElement>('[aria-label="Tunnel listener port"]')!, "1080");
    // The row starts with a loopback target prefilled; emptying it is the case
    // the popover's rule rejects, so the dialog must reject it too.
    type(form.querySelector<HTMLInputElement>('[aria-label="Tunnel target host"]')!, "");
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(host.querySelectorAll(".session-forward-row")).toHaveLength(2);
  });
});
