import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { useStore } from "../store";
import type { SessionProfile } from "../types";
import { DeleteProfileDialog } from "./DeleteProfileDialog";

// The dialog used to count the Sender commands that go with a profile. When the
// list could not be read the count came through as zero, so the dialog said
// nothing was attached while the backend deleted the commands anyway.
const profile = {
  id: "server",
  name: "Server",
  kind: "ssh",
  host: "server",
  port: 22,
  username: "alice",
  auth: "password",
} as unknown as SessionProfile;

const initial = useStore.getState();
let root: Root;
let host: HTMLDivElement;

const mount = (scopedCommands: number | null) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(
      h(DeleteProfileDialog, {
        profile,
        target: "alice@server:22",
        scopedCommands,
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
  });
  return document.body.textContent ?? "";
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState({ ...initial, language: "en" });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initial);
});

it("says it does not know how many Sender commands go with the profile", () => {
  const text = mount(null);
  expect(text).toContain("could not be read");
  // An unknown count must not read as "none".
  expect(text).not.toContain("0 saved");
});

it("still names a known count", () => {
  expect(mount(2)).toContain("2 saved Sender commands");
});
