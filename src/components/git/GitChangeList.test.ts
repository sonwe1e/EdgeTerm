import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitScope, GitSelection } from "../../bindings";
import { useStore } from "../../store";
import { translate } from "../../i18n";
import { GitChangeList } from "./GitChangeList";

vi.mock("../FileIcon", () => ({ FileIcon: () => null }));
vi.mock("../icons", () => ({ Icon: () => null }));

/** One entry per path in `scope`, in the order git reported them. */
const group = (scope: GitScope, paths: string[]): GitSelection[] =>
  paths.map((path) => ({ scope, kind: "modified", path, originalPath: null }));

let host: HTMLDivElement;
let root: Root;

const mount = async (current: GitSelection | undefined, paths: string[]) => {
  await act(async () => {
    root.render(
      h(GitChangeList, {
        groups: { conflict: [], working: group("working", paths), staged: [] },
        current,
        filter: "",
        disabled: false,
        onSelect: () => {},
        onAction: () => {},
      }),
    );
  });
};

const rows = () =>
  [...host.querySelectorAll<HTMLButtonElement>("[data-git-select]")].map(
    (button) => button.getAttribute("aria-label")?.split(" · ")[0] ?? "",
  );

const showMore = () => host.querySelector<HTMLButtonElement>(".git-show-more");

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useStore.setState({ language: "en" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("GitChangeList", () => {
  it("keeps the selected row in place instead of appending it last", async () => {
    // 85 paths: the page holds 80, so the selected one used to be pushed
    // after them. It then read out of order, and the arrow walk dead-ended
    // on it because nothing followed it in the DOM.
    const paths = Array.from({ length: 85 }, (_, index) => `src/file-${index}.ts`);
    const selected = group("working", paths)[82];
    await mount(selected, paths);

    const order = rows();
    expect(order).toHaveLength(83);
    expect(order[82]).toBe("src/file-82.ts");
    expect(order.indexOf("src/file-82.ts")).toBe(82);
    expect(order[order.length - 1]).toBe("src/file-82.ts");
  });

  it("hands the keyboard to the selected row when the last page is shown", async () => {
    // The button unmounts once the raised limit covers every file, so
    // whatever it held has to go somewhere: without this focus fell to the
    // document body and the next Tab restarted at the top of the dialog.
    const paths = Array.from({ length: 85 }, (_, index) => `src/file-${index}.ts`);
    const selected = group("working", paths)[0];
    await mount(selected, paths);
    const button = showMore()!;
    expect(button).not.toBeNull();

    await act(async () => {
      button.focus();
      button.click();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(showMore()).toBeNull();
    const focused = document.activeElement;
    expect(focused?.getAttribute("aria-label")?.startsWith("src/file-0.ts")).toBe(true);
    expect(focused?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps paging while files remain beyond the page", async () => {
    const paths = Array.from({ length: 200 }, (_, index) => `src/file-${index}.ts`);
    await mount(group("working", paths)[0], paths);
    expect(rows()).toHaveLength(80);
    await act(async () => showMore()!.click());
    expect(rows()).toHaveLength(160);
    expect(showMore()?.textContent).toBe(translate("en", "git.showMoreFiles", { count: 40 }));
  });
});
