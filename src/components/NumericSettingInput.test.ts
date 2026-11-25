import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NumericSettingInput } from "./NumericSettingInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const typeValue = (input: HTMLInputElement, next: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

it("keeps intermediate drafts editable, commits valid integers, and clamps on Enter/blur", () => {
  const committed: number[] = [];
  function Harness() {
    const [value, setValue] = useState(64);
    return h(NumericSettingInput, {
      "aria-label": "Chunk",
      value,
      min: 16,
      max: 256,
      onCommit: (next) => {
        committed.push(next);
        setValue(next);
      },
    });
  }
  act(() => root.render(h(Harness)));
  const input = host.querySelector<HTMLInputElement>("input")!;
  act(() => input.focus());

  typeValue(input, "");
  expect(input.value).toBe("");
  typeValue(input, "1");
  expect(input.value).toBe("1");
  typeValue(input, "12");
  expect(input.value).toBe("12");
  expect(committed).toEqual([]);

  typeValue(input, "128");
  expect(input.value).toBe("128");
  expect(committed).toEqual([128]);

  typeValue(input, "999");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(input.value).toBe("256");
  expect(committed).toEqual([128, 256]);
});

it("reverts to the true controlled value when a caller rejects a commit", () => {
  const reject = vi.fn();
  act(() =>
    root.render(
      h(NumericSettingInput, {
        "aria-label": "Rate",
        value: 64,
        min: 16,
        max: 256,
        onCommit: reject,
      }),
    ),
  );
  const input = host.querySelector<HTMLInputElement>("input")!;
  act(() => input.focus());
  typeValue(input, "500");
  act(() => input.blur());
  expect(reject).toHaveBeenCalledWith(256);
  // Because the parent kept value at 64, the unfocused field must show 64.
  expect(input.value).toBe("64");
});
