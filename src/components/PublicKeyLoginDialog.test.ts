import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  configurePublicKeyLogin: vi.fn(),
  cancelKeyCheck: vi.fn(),
  inspectPrivateKey: vi.fn(),
  newKeyCheckId: vi.fn(() => "check-1"),
}));
vi.mock("../api", () => api);
vi.mock("../nativeDialog", () => ({ open: vi.fn() }));
// The dialog translates its labels through the store-backed useT hook; this
// test mocks the backend and does not set up the store, so bind useT to the
// real English catalog directly (no store, no platform globals).
vi.mock("../useT", async () => {
  const i18n = await vi.importActual<typeof import("../i18n")>("../i18n");
  return {
    useT: () => (key: import("../i18n").MessageKey, params?: Record<string, string | number>) =>
      i18n.translate("en", key, params),
  };
});

import type { KeySetup } from "../api";
import type { SessionProfile } from "../types";
import { PublicKeyLoginDialog } from "./PublicKeyLoginDialog";

const profile: SessionProfile = {
  id: "p1",
  name: "prod",
  kind: "ssh",
  host: "host.example",
  port: 22,
  username: "ops",
};

const AUTHORIZED_KEYS = "/home/ops/.ssh/authorized_keys";

/** The install wrote a line, and the check refused the key. */
const refused: KeySetup = {
  install: { path: AUTHORIZED_KEYS, outcome: "added", options: null },
  check: { outcome: "denied", message: "the server refused the key", change: null },
  saved: false,
};

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  if (!found) throw new Error(`no button labeled ${label}`);
  return found;
}

/** Writes into a React-controlled input the way a user would. */
function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.newKeyCheckId.mockReturnValue("check-1");
  api.inspectPrivateKey.mockResolvedValue({
    keyType: "ssh-ed25519",
    publicKey: "ssh-ed25519 AAAAC3Nza ops@laptop",
    fingerprint: "SHA256:AbCdEf",
    encrypted: false,
  });
});

function render(onConfigured = vi.fn(), onClose = vi.fn()) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const mount = async () =>
    act(async () =>
      root.render(
        h(PublicKeyLoginDialog, {
          profile,
          sessionId: "s1",
          onConfigured,
          onClose,
        }),
      ),
    );
  return { host, root, mount, onConfigured, onClose };
}

describe("PublicKeyLoginDialog", () => {
  it("reports an install that was not verified, and changes nothing", async () => {
    api.configurePublicKeyLogin.mockResolvedValue(refused);
    const { host, root, mount, onConfigured } = render();
    try {
      await mount();
      await act(async () =>
        setInput(host.querySelector("input")!, "/home/ops/.ssh/id_ed25519"),
      );
      await act(async () => button(host, "Install and Verify").click());

      expect(api.configurePublicKeyLogin).toHaveBeenCalledWith(
        "s1",
        "check-1",
        "p1",
        "/home/ops/.ssh/id_ed25519",
        null,
      );
      expect(host.textContent).toContain("Installed, but not verified");
      expect(host.textContent).toContain("the server refused the key");
      expect(host.textContent).toContain("The saved session was not changed.");
      expect(onConfigured).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("adopts the key only once the check proves it logs in alone", async () => {
    api.configurePublicKeyLogin.mockResolvedValue({
      install: { path: AUTHORIZED_KEYS, outcome: "present", options: null },
      check: {
        outcome: "ready",
        message: "the server accepted the key and nothing else",
        change: null,
      },
      saved: true,
    } satisfies KeySetup);
    const { host, root, mount, onConfigured } = render();
    try {
      await mount();
      const inputs = host.querySelectorAll("input");
      await act(async () => setInput(inputs[0], "/home/ops/.ssh/id_ed25519"));
      await act(async () => setInput(inputs[1], "hunter2"));
      await act(async () => button(host, "Install and Verify").click());

      expect(api.configurePublicKeyLogin).toHaveBeenCalledWith(
        "s1",
        "check-1",
        "p1",
        "/home/ops/.ssh/id_ed25519",
        "hunter2",
      );
      expect(onConfigured).toHaveBeenCalledWith({
        privateKeyPath: "/home/ops/.ssh/id_ed25519",
        passphrase: "hunter2",
      });
      expect(host.textContent).toContain(
        "The key alone logs in; this session now uses it.",
      );
      expect(host.textContent).toContain(AUTHORIZED_KEYS);
    } finally {
      act(() => root.unmount());
    }
  });

  it("Cancel stops the check but still reports what the install did", async () => {
    let settle!: (value: KeySetup) => void;
    api.configurePublicKeyLogin.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { host, root, mount, onConfigured, onClose } = render();
    try {
      await mount();
      await act(async () =>
        setInput(host.querySelector("input")!, "/home/ops/.ssh/id_ed25519"),
      );
      await act(async () => button(host, "Install and Verify").click());
      await act(async () => button(host, "Cancel").click());

      expect(api.cancelKeyCheck).toHaveBeenCalledWith("check-1");
      expect(host.textContent).toContain("Cancelling…");

      await act(async () =>
        settle({
          install: { path: AUTHORIZED_KEYS, outcome: "added", options: null },
          check: {
            outcome: "cancelled",
            message: "the public-key check was cancelled",
            change: null,
          },
          saved: false,
        }),
      );
      expect(host.textContent).toContain("Installed, but not verified");
      expect(host.textContent).toContain("the public-key check was cancelled");
      expect(onConfigured).not.toHaveBeenCalled();
      // The install may already have happened, so the dialog stays up to
      // report it rather than closing on Cancel.
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
