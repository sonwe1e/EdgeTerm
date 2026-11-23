import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { commandHistory } from "../history";
import { defaultShortcuts } from "../shortcuts";
import { SNIPPETS_KEY } from "../snippets";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * Saved commands end to end: the dialog saves a command, clicking it sends the
 * command and one Enter through the normal input funnel, and a shell-less app
 * refuses with a reason instead of dropping the bytes.
 */

const WRITES: { id: string; data: string }[] = [];
let CLIPBOARD = "";
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "write_session") WRITES.push({ id: String(args.id), data: String(args.data) });
    if (command === "write_clipboard_text") {
      CLIPBOARD = String(args.text);
      return null;
    }
    if (command === "read_clipboard_text") return CLIPBOARD;
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    return null;
  },
};

const initial = useStore.getState();
const ID = "snippet-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "snippet",
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-snippet",
    address: "snippet.internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: {
    id: "p-snippet",
    name: "snippet",
    kind: "ssh",
    host: "snippet.internal",
    username: "ops",
  },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const statusText = () =>
  document.querySelector<HTMLElement>(".status-message-text")?.textContent ?? "";

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(20);
};

const openSnippets = async () => {
  const titles = Array.from(document.querySelectorAll<HTMLElement>("[id^='menu-title-']"));
  const view = titles.find((node) => node.textContent?.trim() === "View");
  expect(view, "the View menu").toBeDefined();
  await userEvent.click(view!);
  await twoFrames();
  const entry = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (node) => node.textContent?.trim().startsWith("Saved Commands"),
  );
  expect(entry, "the Saved Commands entry").toBeDefined();
  await userEvent.click(entry!);
  await until(() => document.querySelector("#snippets-title") !== null);
  await twoFrames();
};

const fill = async (selector: string, value: string) => {
  const field = document.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await twoFrames();
};

async function mountSession() {
  await page.viewport(1100, 720);
  useStore.getState().setShortcuts(defaultShortcuts());
  useStore.setState({
    ...initial,
    tabs: [tab()],
    activeId: ID,
    panes: [{ id: "root", activeTabId: ID }],
    layout: { kind: "leaf", paneId: "root" },
    activePaneId: "root",
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
  });
  useStore.getState().setLanguage("en");
  mount(h(App));
  await expect.poll(() => getController(ID)?.term.element?.isConnected).toBe(true);
  await twoFrames();
}

describe("saved commands", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ snippets: [] });
    WRITES.length = 0;
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
  });

  it("names its own keys for assistive technology", async () => {
    await mountSession();
    // After mounting: the app loads its own state on start, so a value written
    // before that load is replaced.
    useStore.setState({ snippets: [{ id: "s1", name: "Logs", command: "tail -f app.log" }] });
    await twoFrames();
    await openSnippets();
    // F2 loads a row into the form and Delete removes it; the arrows between
    // rows come with the list, so the row names only these two.
    const row = document.querySelector<HTMLElement>(".snippets-send")!;
    expect(row.getAttribute("aria-keyshortcuts")).toBe("F2 Delete");
    const filter = document.querySelector<HTMLElement>(".snippets-filter")!;
    expect(filter.getAttribute("aria-keyshortcuts"), "and the filter names /").toBe("/");
  });

  it("saves a command in the dialog and sends it to the shell", async () => {
    await mountSession();
    await openSnippets();

    await fill(".snippets-name-input", "Logs");
    await fill(".snippets-command-input", "tail -f app.log");
    await userEvent.click(
      Array.from(document.querySelectorAll<HTMLButtonElement>(".snippets-form .btn")).find(
        (node) => node.textContent?.trim() === "Add",
      )!,
    );
    await until(() => document.querySelectorAll(".snippets-row").length === 1);
    expect(useStore.getState().snippets.map((item) => item.name)).toEqual(["Logs"]);
    expect(JSON.parse(localStorage.getItem(SNIPPETS_KEY)!)).toHaveLength(1);

    await userEvent.click(document.querySelector<HTMLElement>(".snippets-send")!);
    await until(() => statusText().startsWith("Sent:"));
    expect(statusText()).toBe("Sent: Logs");
    expect(WRITES).toEqual([{ id: ID, data: "tail -f app.log\r" }]);

    const deleteButton = Array.from(
      document.querySelectorAll<HTMLElement>(".snippets-delete"),
    ).find((node) => node.getAttribute("aria-label")?.startsWith("Delete"))!;
    await userEvent.click(deleteButton);
    await until(() => document.querySelectorAll(".snippets-row").length === 0);
    expect(useStore.getState().snippets).toEqual([]);
    expect(JSON.parse(localStorage.getItem(SNIPPETS_KEY)!)).toEqual([]);
  });

  it("refuses to send when there is no live shell", async () => {
    await page.viewport(1100, 720);
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({ ...initial, tabs: [], activeId: null, gpuRenderer: false });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await twoFrames();
    await openSnippets();
    await fill(".snippets-name-input", "Hello");
    await fill(".snippets-command-input", "echo hello");
    await userEvent.click(
      Array.from(document.querySelectorAll<HTMLButtonElement>(".snippets-form .btn")).find(
        (node) => node.textContent?.trim() === "Add",
      )!,
    );
    await until(() => document.querySelectorAll(".snippets-row").length === 1);
    await userEvent.click(document.querySelector<HTMLElement>(".snippets-send")!);
    await until(() => statusText().length > 0);
    expect(statusText()).toContain("Open a connected shell first");
    expect(WRITES, "nothing was written anywhere").toEqual([]);
  });

  it("sends a saved command from the palette", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    await twoFrames();

    await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    await twoFrames();
    const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, "Send Logs");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await twoFrames();
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await until(() => statusText().startsWith("Sent:"));
    expect(statusText()).toBe("Sent: Logs");
    expect(WRITES).toEqual([{ id: ID, data: "tail -f app.log\r" }]);
  });

  it("saves the last submitted command under a name", async () => {
    await mountSession();
    const controller = getController(ID)!;
    const write = (text: string) =>
      new Promise<void>((resolve) => controller.term.write(text, resolve));

    // Exactly what a submitted line looks like to the tracker: the app records
    // the line on Enter, then the shell announces the command's end.
    controller.noteCommandSent("echo hi");
    await write("\x1b]133;C\x07");
    await write("\x1b]133;D;0\x07");
    await twoFrames();
    expect(controller.lastCommandText(), "the tracker kept the submitted line").toBe("echo hi");

    await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    await twoFrames();
    const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, "Save Last Command");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await twoFrames();
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await until(() => document.querySelector("#group-name-title") !== null);
    expect(document.querySelector<HTMLElement>("#group-name-title")?.textContent).toBe(
      "Save Command as a Snippet",
    );
    expect(document.querySelector<HTMLElement>(".confirm-dialog-hint")?.textContent).toContain(
      "echo hi",
    );

    const nameField = document.querySelector<HTMLInputElement>(".confirm-dialog input")!;
    const nameSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    nameSetter.call(nameField, "Greeting");
    nameField.dispatchEvent(new Event("input", { bubbles: true }));
    nameField.form!.requestSubmit();
    await until(() => useStore.getState().snippets.length === 1);
    expect(useStore.getState().snippets[0]).toMatchObject({ name: "Greeting", command: "echo hi" });
  });

  it("refuses to save when nothing has been submitted", async () => {
    await mountSession();
    await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    await twoFrames();
    const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, "Save Last Command");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await twoFrames();
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await until(() => statusText().length > 0);
    expect(statusText()).toBe("No submitted command to save yet");
    expect(document.querySelector("#group-name-title"), "no prompt without a command").toBeNull();
  });

  it("asks for a template's values before sending it", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Deploy", "deploy {{env}} --tag {{tag}}");
    await twoFrames();
    await openSnippets();

    await userEvent.click(document.querySelector<HTMLElement>(".snippets-send")!);
    await until(() => document.querySelector("#snippet-args-title") !== null);
    const dialog = document.querySelector<HTMLElement>("#snippet-args-title")!;
    expect(dialog.textContent).toBe("Fill in Deploy");
    expect(document.querySelector<HTMLElement>(".snippet-args-preview")?.textContent).toBe(
      "deploy {{env}} --tag {{tag}}",
    );

    const fields = Array.from(
      document.querySelectorAll<HTMLInputElement>(".snippet-args-dialog input"),
    );
    expect(fields.map((field) => field.getAttribute("aria-label"))).toEqual(["env", "tag"]);
    const send = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".snippet-args-dialog .btn"),
    ).find((node) => node.textContent?.trim() === "Send")!;
    expect(send.disabled, "Send waits for every value").toBe(true);

    const setValue = (field: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setValue(fields[0], "prod");
    await twoFrames();
    expect(send.disabled, "one value is still missing").toBe(true);
    setValue(fields[1], "v9");
    await twoFrames();
    expect(send.disabled).toBe(false);

    await userEvent.click(send);
    await until(() => WRITES.length > 0);
    expect(WRITES).toEqual([{ id: ID, data: "deploy prod --tag v9\r" }]);
    expect(document.querySelector("#snippet-args-title"), "the prompt closes").toBeNull();
  });

  it("edits a saved command in place and refuses a colliding name", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail app.log");
    useStore.getState().saveSnippet("Deploy", "deploy");
    await twoFrames();
    await openSnippets();

    const editButtons = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".snippets-delete")).filter((node) =>
        node.getAttribute("aria-label")?.startsWith("Edit"),
      );
    const saveChanges = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".snippets-form .btn")).find(
        (node) => node.textContent?.trim() === "Save Changes",
      )!;

    await userEvent.click(editButtons()[0]);
    await twoFrames();
    expect(document.querySelector<HTMLInputElement>(".snippets-name-input")!.value).toBe("Logs");
    await fill(".snippets-command-input", "tail -f app.log");
    await userEvent.click(saveChanges());
    await until(() => useStore.getState().snippets[0].command === "tail -f app.log");
    expect(useStore.getState().snippets[0].name).toBe("Logs");

    // Renaming onto another command's name must not merge or overwrite it.
    await userEvent.click(editButtons()[1]);
    await twoFrames();
    await fill(".snippets-name-input", "Logs");
    await userEvent.click(saveChanges());
    await until(() => document.querySelector(".dialog-error") !== null);
    expect(document.querySelector(".dialog-error")!.textContent).toBe(
      "Another saved command already uses this name",
    );
    expect(useStore.getState().snippets[1].name).toBe("Deploy");
  });

  it("filters the list by name or command text", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    useStore.getState().saveSnippet("Deploy", "deploy prod");
    await twoFrames();
    await openSnippets();
    const rows = () => document.querySelectorAll(".snippets-row").length;
    expect(rows()).toBe(2);

    await fill(".snippets-filter", "tail");
    await until(() => rows() === 1);
    expect(rows()).toBe(1);

    await fill(".snippets-filter", "nothing like this");
    await until(() => document.querySelector(".snippets-empty") !== null);
    expect(document.querySelector(".snippets-empty")!.textContent).toContain(
      "No saved command matches",
    );

    await fill(".snippets-filter", "");
    await until(() => rows() === 2);
    expect(rows()).toBe(2);
  });

  it("moves saved commands through the clipboard", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    await twoFrames();
    await openSnippets();

    const button = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".snippets-dialog .btn")).find(
        (node) => node.textContent?.trim() === label,
      )!;

    CLIPBOARD = "";
    await userEvent.click(button("Copy All"));
    await until(() => CLIPBOARD.length > 0);
    const bundle = JSON.parse(CLIPBOARD);
    expect(bundle).toMatchObject({ format: "edgeterm-snippets", version: 1 });
    expect(bundle.snippets).toEqual([{ name: "Logs", command: "tail -f app.log" }]);
    await until(() => document.querySelector(".snippets-notice") !== null);
    expect(document.querySelector(".snippets-notice")!.textContent).toBe("Copied 1 saved commands");

    CLIPBOARD = JSON.stringify({
      format: "edgeterm-snippets",
      version: 1,
      snippets: [{ name: "Deploy", command: "deploy prod" }],
    });
    await userEvent.click(button("Import from Clipboard"));
    await until(() => useStore.getState().snippets.length === 2);
    expect(useStore.getState().snippets[1]).toMatchObject({
      name: "Deploy",
      command: "deploy prod",
    });
    expect(document.querySelector(".snippets-notice")!.textContent).toBe(
      "Imported 1 saved commands",
    );

    CLIPBOARD = "not json";
    await userEvent.click(button("Import from Clipboard"));
    await until(() => document.querySelector(".dialog-error") !== null);
    expect(document.querySelector(".dialog-error")!.textContent).toBe(
      "The clipboard does not contain JSON",
    );
    expect(useStore.getState().snippets).toHaveLength(2);
  });

  it("opens the manager from the command palette", async () => {
    await mountSession();
    await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    await twoFrames();
    const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, "Saved Commands");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await twoFrames();
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await until(() => document.getElementById("snippets-title") !== null);
    expect(document.getElementById("snippets-title")!.textContent).toBe("Saved Commands");
  });

  it("sends a saved command from the terminal's context menu", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    // The menu is one of the right button's modes; the component reads it on
    // render, so it has to be set before the frame that draws the handler.
    useStore.getState().setRightClickAction("menu");
    await twoFrames();

    const surface = document.querySelector<HTMLElement>(".xterm")!;
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    );
    await twoFrames();
    const trigger = Array.from(document.querySelectorAll<HTMLElement>("[data-submenu-key]")).find(
      (node) => node.textContent?.includes("Send Saved Command"),
    );
    expect(trigger, "the menu offers saved commands").toBeDefined();

    trigger!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await until(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".menu-entry")).some(
        (node) => node.textContent?.trim() === "Logs",
      ),
    );
    const item = Array.from(document.querySelectorAll<HTMLElement>(".menu-entry")).find(
      (node) => node.textContent?.trim() === "Logs",
    )!;
    await userEvent.click(item);
    await until(() => WRITES.length > 0);
    expect(WRITES).toEqual([{ id: ID, data: "tail -f app.log\r" }]);
  });

  it("sends a recent command from the terminal's context menu", async () => {
    await mountSession();
    // The menu reads the same in-memory history the shell feeds on Enter.
    commandHistory.record("git status", "ssh:box");
    useStore.getState().setRightClickAction("menu");
    await twoFrames();

    const surface = document.querySelector<HTMLElement>(".xterm")!;
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    );
    await twoFrames();
    const trigger = Array.from(document.querySelectorAll<HTMLElement>("[data-submenu-key]")).find(
      (node) => node.textContent?.includes("Recent Commands"),
    );
    expect(trigger, "the menu offers recent commands").toBeDefined();

    trigger!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await until(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".menu-entry")).some(
        (node) => node.textContent?.trim() === "git status",
      ),
    );
    const item = Array.from(document.querySelectorAll<HTMLElement>(".menu-entry")).find(
      (node) => node.textContent?.trim() === "git status",
    )!;
    await userEvent.click(item);
    await until(() => WRITES.length > 0);
    expect(WRITES).toEqual([{ id: ID, data: "git status\r" }]);
    expect(statusText(), "a history pick is already on screen").not.toContain("Sent:");
  });

  it("opens the manager from the terminal's context menu", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    useStore.getState().setRightClickAction("menu");
    await twoFrames();

    const surface = document.querySelector<HTMLElement>(".xterm")!;
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    );
    await twoFrames();
    const manage = Array.from(document.querySelectorAll<HTMLElement>(".menu-entry")).find(
      (node) => node.textContent?.trim() === "Saved Commands",
    );
    expect(manage, "the menu opens the manager").toBeDefined();
    await userEvent.click(manage!);
    await until(() => document.getElementById("snippets-title") !== null);
    expect(document.getElementById("snippets-title")!.textContent).toBe("Saved Commands");
  });

  it("keeps a long command row inside the window and keeps its text on hover", async () => {
    await mountSession();
    const long = "kubectl get pods --namespace production --selector app=checkout --output wide";
    commandHistory.record(long, "ssh:box");
    useStore.getState().setRightClickAction("menu");
    await twoFrames();

    const surface = document.querySelector<HTMLElement>(".xterm")!;
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    );
    await twoFrames();
    const trigger = Array.from(document.querySelectorAll<HTMLElement>("[data-submenu-key]")).find(
      (node) => node.textContent?.includes("Recent Commands"),
    )!;
    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await until(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".menu-entry")).some(
        (node) => node.textContent?.trim() === long,
      ),
    );
    const item = Array.from(document.querySelectorAll<HTMLElement>(".menu-entry")).find(
      (node) => node.textContent?.trim() === long,
    )!;
    const panel = item.closest<HTMLElement>(".menu-dropdown")!;
    expect(panel.getBoundingClientRect().width, "the submenu stays inside the window").toBeLessThan(
      448,
    );
    const label = item.querySelector<HTMLElement>(".menu-entry-label")!;
    expect(label.scrollWidth, "the label is cut short, not wrapped").toBeGreaterThan(
      label.clientWidth,
    );
    expect(item.title, "hover keeps the whole command").toBe(long);
  });

  it("saves the last command from the terminal's context menu", async () => {
    await mountSession();
    const controller = getController(ID)!;
    controller.noteCommandSent("kubectl get pods");
    await new Promise<void>((resolve) => controller.term.write("\x1b]133;C\x07", resolve));
    await new Promise<void>((resolve) => controller.term.write("\x1b]133;D;0\x07", resolve));
    useStore.getState().setRightClickAction("menu");
    await twoFrames();

    const surface = document.querySelector<HTMLElement>(".xterm")!;
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    );
    await twoFrames();
    const item = Array.from(document.querySelectorAll<HTMLElement>(".menu-entry")).find((node) =>
      node.textContent?.includes("Save Last Command"),
    );
    expect(item, "the menu offers saving the last command").toBeDefined();
    await userEvent.click(item!);
    await until(() => document.querySelector("#group-name-title") !== null);
    expect(document.querySelector<HTMLElement>(".confirm-dialog-hint")?.textContent).toContain(
      "kubectl get pods",
    );

    const nameField = document.querySelector<HTMLInputElement>(".confirm-dialog input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameField, "Pods");
    nameField.dispatchEvent(new Event("input", { bubbles: true }));
    nameField.form!.requestSubmit();
    await until(() => useStore.getState().snippets.some((snippet) => snippet.name === "Pods"));
    expect(useStore.getState().snippets.find((snippet) => snippet.name === "Pods")?.command).toBe(
      "kubectl get pods",
    );
  });

  it("opens the manager from its default chord", async () => {
    await mountSession();
    await twoFrames();
    await userEvent.keyboard("{Control>}{Shift>}S{/Shift}{/Control}");
    await until(() => document.getElementById("snippets-title") !== null);
    expect(document.getElementById("snippets-title")!.textContent).not.toBeNull();
  });

  it("tells a reader with nothing saved where to save one", async () => {
    await mountSession();
    await twoFrames();
    await openSnippets();

    const empty = document.querySelector<HTMLElement>(".snippets-empty")!;
    expect(empty.textContent).toContain("Nothing saved yet");
    expect(empty.textContent, "the two quicker paths are named").toContain(
      "Save Last Command as a Snippet",
    );

    // With something saved the extra hint goes away: it is guidance for an
    // empty list, not a permanent paragraph.
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    await twoFrames();
    expect(document.querySelector(".snippets-empty")).toBeNull();
    expect(document.querySelector(".snippets-empty-hint")).toBeNull();
  });

  it("clears the filter on Escape before closing the dialog", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    await twoFrames();
    await openSnippets();

    const filter = document.querySelector<HTMLInputElement>(".snippets-filter")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(filter, "nothing matches");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await twoFrames();
    expect(document.querySelector(".snippets-empty")?.textContent).toContain("nothing matches");

    filter.focus();
    await userEvent.keyboard("{Escape}");
    await twoFrames();
    expect(filter.value, "the filter is cleared").toBe("");
    expect(document.getElementById("snippets-title"), "the dialog stays open").not.toBeNull();

    await userEvent.keyboard("{Escape}");
    await twoFrames();
    expect(document.getElementById("snippets-title"), "the second press closes it").toBeNull();
  });

  it("duplicates a command whose name already uses the whole limit", async () => {
    await mountSession();
    const long = "x".repeat(60);
    useStore.getState().saveSnippet(long, "echo hi");
    await twoFrames();
    await openSnippets();

    const duplicate = document.querySelector<HTMLButtonElement>(
      '.snippets-delete[aria-label="Duplicate ' + long + '"]',
    );
    expect(duplicate, "the row offers a duplicate").not.toBeNull();
    await userEvent.click(duplicate!);
    await until(() => useStore.getState().snippets.length === 2);
    const names = useStore.getState().snippets.map((snippet) => snippet.name);
    expect(new Set(names).size, "the copy is a second entry, not an overwrite").toBe(2);
    expect(names).toContain(long);
    expect(useStore.getState().snippets.find((snippet) => snippet.name === long)?.command).toBe(
      "echo hi",
    );
  });

  it("remembers the values a parameterised command was last run with", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Deploy", "deploy {{env}}");
    await twoFrames();
    await openSnippets();

    const openArgs = async () => {
      await userEvent.click(document.querySelector<HTMLElement>(".snippets-send")!);
      await until(() => document.querySelector(".snippet-args-dialog input") !== null);
    };

    await openArgs();
    const first = document.querySelector<HTMLInputElement>(".snippet-args-dialog input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(first, "prod");
    first.dispatchEvent(new Event("input", { bubbles: true }));
    await twoFrames();
    first.form!.requestSubmit();
    await until(() => WRITES.some((write) => write.data === "deploy prod\r"));

    await openArgs();
    const second = document.querySelector<HTMLInputElement>(".snippet-args-dialog input")!;
    expect(second.value, "the last answer is offered again").toBe("prod");
    const send = document.querySelector<HTMLButtonElement>(".snippet-args-dialog .btn.is-primary")!;
    expect(send.disabled, "nothing left to type").toBe(false);
    send.click();
    await until(() => WRITES.filter((write) => write.data === "deploy prod\r").length === 2);
  });

  it("duplicates a saved command without touching the original", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    await twoFrames();
    await openSnippets();

    const duplicate = document.querySelector<HTMLButtonElement>(
      '.snippets-delete[aria-label="Duplicate Logs"]',
    );
    expect(duplicate, "the row offers a duplicate").not.toBeNull();
    await userEvent.click(duplicate!);
    await until(() => useStore.getState().snippets.length === 2);
    const names = useStore
      .getState()
      .snippets.map((snippet) => snippet.name)
      .sort();
    expect(names).toEqual(["Logs", "Logs copy"]);
    expect(
      useStore.getState().snippets.find((snippet) => snippet.name === "Logs copy")?.command,
    ).toBe("tail -f app.log");
    expect(
      useStore.getState().snippets.find((snippet) => snippet.name === "Logs")?.command,
      "the source still runs what it ran",
    ).toBe("tail -f app.log");
  });

  it("opens the filter with the slash key from a row", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Deploy", "deploy prod");
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    await twoFrames();
    await openSnippets();
    const row = document.querySelector<HTMLElement>(".snippets-send")!;
    row.focus();
    await twoFrames();
    await userEvent.keyboard("/");
    await twoFrames();
    expect(document.activeElement).toBe(document.querySelector(".snippets-filter"));
  });

  it("steps back out of an edit before Escape closes the manager", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Deploy", "deploy prod");
    await twoFrames();
    await openSnippets();
    await userEvent.click(page.getByLabelText("Edit Deploy"));
    await twoFrames();
    const form = () => document.querySelector<HTMLInputElement>(".snippets-name-input")!;
    expect(form().value).toBe("Deploy");

    await userEvent.keyboard("{Escape}");
    await twoFrames();
    expect(document.querySelector("#snippets-title"), "the manager stays open").not.toBeNull();
    expect(form().value, "the edit is discarded").toBe("");
    expect(useStore.getState().snippets, "the row itself is untouched").toHaveLength(1);
    expect(useStore.getState().snippets[0].name).toBe("Deploy");

    await userEvent.keyboard("{Escape}");
    await twoFrames();
    expect(document.querySelector("#snippets-title"), "the second Escape closes").toBeNull();
  });

  it("loads the row under the cursor into the form with F2", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    useStore.getState().saveSnippet("Deploy", "deploy prod");
    await twoFrames();
    await openSnippets();

    const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".snippets-send"));
    rows()[1].focus();
    await twoFrames();
    await userEvent.keyboard("{F2}");
    await twoFrames();
    const name = document.querySelector<HTMLInputElement>(".snippets-form input")!;
    expect(name.value, "F2 puts the row's name in the form").toBe("Deploy");
    expect(document.activeElement, "the field is ready to type into").toBe(name);
    expect(
      [name.selectionStart, name.selectionEnd],
      "the whole name is selected, so typing replaces it",
    ).toEqual([0, "Deploy".length]);
    expect(WRITES, "F2 never sends").toEqual([]);
    expect(useStore.getState().snippets).toHaveLength(2);
  });

  it("walks the list with the arrows and deletes the row under the cursor", async () => {
    await mountSession();
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    useStore.getState().saveSnippet("Deploy", "deploy prod");
    await twoFrames();
    await openSnippets();

    const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".snippets-send"));
    expect(rows()).toHaveLength(2);
    rows()[0].focus();
    await twoFrames();
    expect(document.activeElement, "the first row owns the keyboard").toBe(rows()[0]);

    await userEvent.keyboard("{ArrowDown}");
    await twoFrames();
    expect(document.activeElement, "ArrowDown walks to the next row").toBe(rows()[1]);
    await userEvent.keyboard("{ArrowUp}");
    await twoFrames();
    expect(document.activeElement).toBe(rows()[0]);

    await userEvent.keyboard("{Delete}");
    await until(() => useStore.getState().snippets.length === 1);
    expect(useStore.getState().snippets[0].name).toBe("Deploy");
    expect(WRITES, "Delete removes, it never sends").toEqual([]);
  });
});
