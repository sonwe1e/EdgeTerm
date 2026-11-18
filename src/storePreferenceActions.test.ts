import { expect, it } from "vitest";
import { useStore } from "./store";

it("does not let an imported file switch off the paste and clipboard guards", () => {
  const before = useStore.getState();
  expect(before.pasteWarning).toBe(true);
  expect(before.programClipboard).toBe("ask");

  useStore.getState().applySettings({
    pasteWarning: false,
    programClipboard: "allow",
    copyOnSelect: true,
  });

  const after = useStore.getState();
  // A data file cannot turn either guard off: the dialog that imports it never
  // mentions them, so a flip would be a silent weakening.
  expect(after.pasteWarning).toBe(true);
  expect(after.programClipboard).toBe("ask");
  // Everything else in the file still applies.
  expect(after.copyOnSelect).toBe(true);

  after.setCopyOnSelect(false);
});
