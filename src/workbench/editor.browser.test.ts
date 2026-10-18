import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import "../styles.css";
import { browserAfterEach, frame, mount, twoFrames, wait } from "../test/browserHarness";
import { CodeEditor } from "./CodeEditor";
import { forgetEditorState } from "./editorState";
import type { EditorDoc } from "./types";

/**
 * Real CodeMirror in a real browser, driven through the same component the
 * workbench mounts. These contracts are about what survives a file switch:
 * undo history, selection and reading position. jsdom cannot see them (no
 * layout, no scroll), and a state built from text cannot have them at all.
 */

afterEach(browserAfterEach);

function docOf(id: string, path: string, content: string): EditorDoc {
  return {
    id,
    workspaceId: id.split("::")[0],
    experimentId: "e1",
    serverKey: "lab@gpu-01:22",
    serverLabel: "gpu-01",
    projectName: "vfi",
    path,
    absolutePath: `/data/vfi/${path}`,
    content,
    savedContent: content,
    hash: "h1",
    remoteHash: null,
    size: content.length,
    encoding: "UTF-8",
    eol: "lf",
    bom: false,
    modifiedAt: 1,
    sync: "synced",
    error: null,
    draftRestored: false,
    draftState: "idle",
    draftError: null,
    revealLine: null,
    lastActiveAt: 1,
  };
}

const lines = Array.from({ length: 160 }, (_, index) => `value_${index} = ${index}`).join("\n");

/**
 * The editor needs a flex parent with a real height, like .wb-editor in the
 * workbench, or the scroller has nothing to scroll.
 */
function editorElement(doc: EditorDoc, contents: Map<string, string>, key = doc.id) {
  return createElement(
    "div",
    { style: { display: "flex", height: "100vh" } },
    createElement(CodeEditor, {
      key,
      doc: { ...doc, content: contents.get(doc.id) ?? doc.content },
      dark: false,
      fontSize: 13,
      onChange: (content) => contents.set(doc.id, content),
      onSave: () => undefined,
      onRevealed: () => undefined,
    }),
  );
}

function viewIn(container: HTMLElement): EditorView | null {
  const element = container.querySelector(".cm-editor");
  return element ? EditorView.findFromDOM(element as HTMLElement) : null;
}

async function untilView(container: HTMLElement, timeout = 4000): Promise<EditorView> {
  const started = Date.now();
  for (;;) {
    const view = viewIn(container);
    if (view) return view;
    if (Date.now() - started > timeout) throw new Error("the editor never mounted");
    await wait(20);
  }
}

async function type(view: EditorView, insert: string): Promise<void> {
  const at = view.state.doc.length;
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    userEvent: "input.type",
  });
  await frame();
}

describe("workbench editor: switching files keeps the editing position", () => {
  it("keeps undo history, selection and scroll when another file is opened and closed", async () => {
    const a = docOf("w1::/data/vfi/src/a.py", "src/a.py", lines);
    const b = docOf("w1::/data/vfi/src/b.py", "src/b.py", "print('b')\n");
    const contents = new Map([
      [a.id, a.content],
      [b.id, b.content],
    ]);
    const mounted = mount(editorElement(a, contents));

    let view = await untilView(mounted.container);
    view.focus();
    await type(view, "\n# edit in A");

    // A reading position in the middle of the file, with a selection that is
    // not the cursor default.
    const anchor = view.state.doc.line(70).from;
    view.dispatch({ selection: { anchor, head: anchor + 6 } });
    await twoFrames();
    view.scrollDOM.scrollTop = 620;
    await twoFrames();
    const scrolled = view.scrollDOM.scrollTop;
    expect(scrolled).toBeGreaterThan(200);

    // Open B, which unmounts A's view, and edit it.
    mounted.render(editorElement(b, contents));
    const viewB = await untilView(mounted.container);
    await type(viewB, "# edit in B");

    // Back to A: the view is new, the document state must not be.
    mounted.render(editorElement(a, contents));
    view = await untilView(mounted.container);
    await twoFrames();

    expect(view.state.doc.toString()).toContain("# edit in A");
    expect(view.state.doc.toString()).not.toContain("# edit in B");
    expect(view.state.selection.main.anchor).toBe(anchor);
    expect(view.state.selection.main.head).toBe(anchor + 6);
    expect(Math.abs(view.scrollDOM.scrollTop - scrolled)).toBeLessThanOrEqual(4);
    // Clicking a tab must leave the keyboard in the editor, or Ctrl+Z cannot
    // reach the history that was just restored.
    expect(document.activeElement?.closest(".cm-editor")).not.toBeNull();

    expect(undo(view)).toBe(true);
    await frame();
    expect(view.state.doc.toString()).not.toContain("# edit in A");
    expect(redo(view)).toBe(true);
    await frame();
    expect(view.state.doc.toString()).toContain("# edit in A");
  }, 60_000);

  it("keeps two projects' copies of the same relative path apart", async () => {
    const one = docOf("w1::/data/vfi/baseline/src/train.py", "src/train.py", "base\n");
    const two = docOf("w2::/data/vfi/ablation-b/src/train.py", "src/train.py", "base\n");
    const contents = new Map([
      [one.id, one.content],
      [two.id, two.content],
    ]);
    const mounted = mount(editorElement(one, contents));

    let view = await untilView(mounted.container);
    await type(view, "# only baseline");

    mounted.render(editorElement(two, contents));
    view = await untilView(mounted.container);
    expect(view.state.doc.toString()).toBe("base\n");
    expect(undo(view)).toBe(false);

    mounted.render(editorElement(one, contents));
    view = await untilView(mounted.container);
    expect(view.state.doc.toString()).toContain("# only baseline");
    expect(undo(view)).toBe(true);
    await frame();
    expect(view.state.doc.toString()).toBe("base\n");
  }, 60_000);

  it("drops undo history when the server content replaces the document", async () => {
    const a = docOf("w1::/data/vfi/src/a.py", "src/a.py", "server v1\n");
    const contents = new Map([[a.id, a.content]]);
    const mounted = mount(editorElement(a, contents));
    let view = await untilView(mounted.container);
    await type(view, "# local edit");

    // Reload from the server: the text is replaced outside the editor, so
    // undo must not resurrect a version that is no longer on the server.
    contents.set(a.id, "server v2\n");
    mounted.render(editorElement(a, contents));
    view = await untilView(mounted.container);
    await frame();
    expect(view.state.doc.toString()).toBe("server v2\n");
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("server v2\n");
  }, 60_000);

  it("keeps history when the whole workbench view is left and re-entered", async () => {
    const a = docOf("w1::/data/vfi/src/a.py", "src/a.py", "view switch\n");
    const contents = new Map([[a.id, a.content]]);
    const mounted = mount(editorElement(a, contents));
    let view = await untilView(mounted.container);
    await type(view, "# before leaving");

    // The terminals view unmounts the workbench, editor included. The
    // document state lives outside that tree.
    mounted.render(null);
    mounted.render(editorElement(a, contents));
    view = await untilView(mounted.container);
    expect(view.state.doc.toString()).toContain("# before leaving");
    expect(undo(view)).toBe(true);
    await frame();
    expect(view.state.doc.toString()).toBe("view switch\n");
  }, 60_000);

  it("does not restore history for a document that was closed", async () => {
    const a = docOf("w1::/data/vfi/src/a.py", "src/a.py", "keep\n");
    const contents = new Map([[a.id, a.content]]);
    const mounted = mount(editorElement(a, contents));
    let view = await untilView(mounted.container);
    await type(view, "# unsaved");

    // Closing the tab releases the document state; reopening starts a new
    // history even when the same path is opened again.
    forgetEditorState(a.id);
    mounted.render(editorElement(a, contents, `${a.id}:reopened`));
    view = await untilView(mounted.container);
    expect(view.state.doc.toString()).toContain("# unsaved");
    expect(undo(view)).toBe(false);
  }, 60_000);
});
