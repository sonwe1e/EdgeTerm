import { afterEach, describe, expect, it } from "vitest";
import { senderRowHadFocus } from "./components/panels/useSenderLibrary";

afterEach(() => {
  document.body.innerHTML = "";
  (document.activeElement as HTMLElement | null)?.blur();
});

describe("senderRowHadFocus", () => {
  it("is true while a control inside a saved-command row holds focus", () => {
    const row = document.createElement("div");
    row.dataset.senderRow = "";
    const button = document.createElement("button");
    row.append(button);
    document.body.append(row);
    button.focus();
    expect(senderRowHadFocus(), "the row is about to go").toBe(true);
  });

  it("is false when focus is anywhere else, including the document", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(senderRowHadFocus()).toBe(false);
    outside.blur();
    expect(senderRowHadFocus(), "nothing focused").toBe(false);
  });
});
