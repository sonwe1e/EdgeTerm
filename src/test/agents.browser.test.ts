import { createElement as h } from "react";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import App from "../App";
import { ensureController } from "../actions";
import { useAgents } from "../agents/model";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
import { AGENT_SETTINGS_KEY } from "../persistKeys";
import "../styles.css";

const initial = useStore.getState();
const writes: { id: string; data: string }[] = [];
const requests: Record<string, unknown>[] = [];
let serial = 0;
let uploadDone: (() => void) | null = null;
const host = window as unknown as { __TAURI_INTERNALS__: unknown };
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
host.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "write_session") {
      writes.push(args as { id: string; data: string });
      return;
    }
    if (command === "coding_agent_inspect")
      return {
        executable: "/usr/bin/pi",
        version: "1.4.0",
        home: "/home/test",
        configRoot: "/home/test/.pi/agent",
      };
    if (command === "project_read_text")
      return {
        path: args.path,
        content: JSON.stringify({
          fullscreenExitOutput: String(args.path).includes("/project/")
            ? "transcript"
            : "resume-hint",
          theme: "custom",
        }),
        hash: "hash",
        eol: "lf",
        encoding: "UTF-8",
        bom: false,
        size: 20,
      };
    if (command === "project_write_text") {
      requests.push({ command, ...args });
      return { uncertain: false };
    }
    if (command === "plugin:dialog|open") return "C:/fixture/picture.png";
    if (command === "transfer_files")
      return new Promise<void>((resolve) => {
        uploadDone = resolve;
      });
    if (command === "session_cwd") return "/project/repo";
    if (command === "sftp_list") return { path: args.path, entries: [] };
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "local_home") return "C:/fixture";
    if (command === "local_list") return { path: "C:/fixture", entries: [] };
    if (command === "plugin:app|version") return "1.6.2";
    if (command === "portable_mode") return false;
    return null;
  },
};

async function fixture(kind: "local" | "ssh" = "local", width = 1100) {
  await page.viewport(width, 800);
  useAgents.setState({
    open: false,
    recognized: {},
    drafts: {},
    initialView: "compose",
    senderAgentMode: false,
    composeRequest: 0,
  });
  const paneId = initial.activePaneId;
  const tab: Tab = {
    info: {
      id: "agent-fixture",
      name: "Agent terminal",
      kind,
      protocol: kind,
      profileId: null,
      address: kind === "ssh" ? "fixture:22" : "cmd.exe",
      color: null,
      supportsRemoteFiles: kind === "ssh",
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id: "profile", name: "fixture", kind, host: "fixture", username: "test" },
    state: "connected",
    number: 1,
    ordinal: 0,
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId,
  };
  useStore.setState({
    tabs: [tab],
    activeId: tab.info.id,
    panes: [{ id: paneId, activeTabId: tab.info.id }],
    language: "en",
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
  });
  mount(h(App));
  useStore.getState().setLanguage("en");
  await expect.poll(() => getController(tab.info.id)?.term.element?.isConnected).toBe(true);
  await twoFrames();
  const controller = getController(tab.info.id)!;
  await new Promise<void>((resolve) => controller.term.write("\x1b[?2004h", resolve));
  writes.length = 0;
  await page.getByRole("button", { name: "Coding Agents", exact: true }).click();
  await expect.element(page.getByRole("dialog", { name: "Coding Agents" })).toBeVisible();
  return controller;
}
afterEach(async () => {
  uploadDone?.();
  await browserAfterEach();
  disposeController("agent-fixture");
  disposeController("agent-other");
  useStore.setState(initial, true);
  useAgents.setState({
    open: false,
    recognized: {},
    drafts: {},
    initialView: "compose",
    senderAgentMode: false,
    composeRequest: 0,
  });
  localStorage.removeItem(AGENT_SETTINGS_KEY);
  writes.length = 0;
  requests.length = 0;
  uploadDone = null;
});

it.each(["local", "ssh"] as const)(
  "stops an idle OpenCode tab animation over %s",
  async (kind) => {
    const controller = await fixture(kind);
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    const bytes = new TextEncoder();
    const output = (text: string) =>
      new Promise<void>((resolve) => controller.write(bytes.encode(text), resolve));
    await output(kind === "ssh" ? "alice@server:~/repo$ " : "PS C:\\fixture> ");
    controller.term.input("opencode", true);
    await output("opencode");
    controller.term.input("\r", true);
    await output("\r\n\x1b[?1049h\x1b]7501;state=idle:app=opencode\x07");

    const first = useStore.getState().tabs[0];
    useStore.setState({
      tabs: [
        first,
        {
          ...first,
          info: { ...first.info, id: "agent-other", name: "Other terminal" },
          number: 2,
        },
      ],
    });
    useStore.getState().setActive("agent-other");
    await twoFrames();
    const tab = document.querySelector<HTMLElement>('[data-tab-id="agent-fixture"]')!;
    const animation = () => getComputedStyle(tab, "::after").animationName;
    const activity = () =>
      useStore.getState().tabs.find((item) => item.info.id === "agent-fixture")?.commandActivity;

    await output("\x1b]7501;state=working:app=opencode\x07");
    await twoFrames();
    expect(activity()).toBe("running");
    expect(animation()).toBe("tab-command-stream");
    await page.screenshot({ path: `../../artifacts/usability/opencode-${kind}-working.png` });
    await output("\x1b]7501;state=idle:app=opencode\x07");
    await twoFrames();
    expect(activity()).toBe("complete");
    expect(animation()).toBe("none");
    await page.screenshot({ path: `../../artifacts/usability/opencode-${kind}-idle.png` });

    controller.term.input("a draft", true);
    for (let index = 0; index < 5; index += 1) {
      await output(`\x1b[HReady ${index}\x1b[K`);
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    expect(activity()).toBe("complete");
    expect(animation()).toBe("none");
    useStore.getState().setActive("agent-fixture");
    await twoFrames();
    expect(activity()).toBe("idle");
  },
  15_000,
);

it("undoes and redoes quoted text and file references in the prompt draft", async () => {
  const controller = await fixture();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("tablist")
    .getByRole("button", { name: "Agent prompt", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Agent prompt", exact: true });
  await editor.click();
  await userEvent.keyboard("Explain this");
  await new Promise<void>((resolve) => controller.term.write("quoted output", resolve));
  controller.term.select(0, 0, 13);
  await page.getByRole("button", { name: "Add terminal selection", exact: true }).click();
  await expect.element(editor).toHaveValue("Explain this\n\nquoted output");
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.element(editor).toHaveValue("Explain this");
  await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  await expect.element(editor).toHaveValue("Explain this\n\nquoted output");
  await page.getByRole("button", { name: "Add file or image reference", exact: true }).click();
  await expect
    .element(editor)
    .toHaveValue('Explain this\n\nquoted output\n\nReferenced file: "C:/fixture/picture.png"');
  await editor.click();
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.element(editor).toHaveValue("Explain this\n\nquoted output");
  expect(writes).toHaveLength(0);
});

it("opens command input from New command after collapsing an agent draft", async () => {
  await fixture();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("tablist")
    .getByRole("button", { name: "Agent prompt", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Agent prompt", exact: true }).fill("keep agent draft");
  await page.getByRole("button", { name: "Collapse Sender", exact: true }).click();
  await page.getByRole("button", { name: /^(New|New command)$/ }).click();
  await expect.poll(() => document.querySelector(".sender-command-input") !== null).toBe(true);
  await expect.poll(() => document.querySelector(".agent-inline-input")).toBeNull();
  expect(useAgents.getState().drafts["agent-fixture"]).toBe("keep agent draft");
});

it("opens an inline composer from the terminal strip and inserts with Ctrl+Enter", async () => {
  await fixture();
  await page
    .getByRole("dialog", { name: "Coding Agents" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("tablist")
    .getByRole("button", { name: "Agent prompt", exact: true })
    .click();
  await expect.poll(() => document.querySelector(".agent-inline-input") !== null).toBe(true);
  expect(document.querySelector(".agent-dialog")).toBeNull();
  const editor = page.getByRole("textbox", { name: "Agent prompt", exact: true });
  await editor.fill("first paragraph\n\n  keep indentation");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].data).toBe("\x1b[200~first paragraph\r\r  keep indentation\x1b[201~");
  await expect.element(editor).toHaveValue("");
  await page.screenshot({ path: "../../artifacts/usability/agents-inline-1100.png" });
  await editor.fill("keep this draft");
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page
    .getByRole("tablist")
    .getByRole("button", { name: "Agent prompt", exact: true })
    .click();
  await expect
    .element(page.getByRole("textbox", { name: "Agent prompt", exact: true }))
    .toHaveValue("keep this draft");
  await page.viewport(900, 560);
  useStore.getState().setLanguage("zh-CN");
  await twoFrames();
  await expect.element(page.getByRole("button", { name: /放入终端输入区/ })).toBeVisible();
  const submitRect = page
    .getByRole("button", { name: /放入终端输入区/ })
    .element()
    .getBoundingClientRect();
  expect(submitRect.bottom).toBeLessThanOrEqual(
    document.querySelector(".statusbar")!.getBoundingClientRect().top + 1,
  );
  await page.screenshot({ path: "../../artifacts/usability/agents-inline-900x560-zh.png" });
});

it("keeps a mouse selection when opening the inline composer resizes the terminal", async () => {
  const controller = await fixture();
  await page
    .getByRole("dialog", { name: "Coding Agents" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await new Promise<void>((resolve) =>
    controller.term.write("\x1b[?1049h\x1b[HSelected agent output", resolve),
  );
  const screen = controller.term.element!.querySelector(".xterm-screen")!;
  const start = pagePoint(screen, 0.25 / controller.term.cols, 0.5 / controller.term.rows);
  const end = pagePoint(screen, 21.25 / controller.term.cols, 0.5 / controller.term.rows);
  await mouse.press(start.x, start.y);
  await mouse.moveTo(end.x, end.y);
  await mouse.release(end.x, end.y);
  await expect.poll(() => controller.term.getSelection()).toBe("Selected agent output");
  await page.screenshot({ path: "../../artifacts/usability/agents-selection-before.png" });
  await page
    .getByRole("tablist")
    .getByRole("button", { name: "Agent prompt", exact: true })
    .click();
  await twoFrames();
  await page.getByRole("button", { name: "Add terminal selection", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Agent prompt", exact: true }))
    .toHaveValue("Selected agent output");
  expect(writes).toHaveLength(0);
  await page.screenshot({ path: "../../artifacts/usability/agents-selection-after.png" });
  // A new gesture in the terminal invalidates the old quote, even when it
  // merely deselects. Reconnecting must never resurrect it either.
  const point = pagePoint(screen, 0.25 / controller.term.cols, 0.5 / controller.term.rows);
  await mouse.press(point.x, point.y);
  await mouse.release(point.x, point.y);
  await page.getByRole("button", { name: "Add terminal selection", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Select text in the terminal first");
  await expect
    .element(page.getByRole("textbox", { name: "Agent prompt", exact: true }))
    .toHaveValue("Selected agent output");
});

it("quotes the visible text of an ordinary TUI drag without stealing its mouse events", async () => {
  const controller = await fixture();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await new Promise<void>((resolve) =>
    controller.term.write(
      "\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[H中文 output\r\n  second line",
      resolve,
    ),
  );
  await twoFrames();
  const screen = controller.term.element!.querySelector(".xterm-screen")!;
  const start = pagePoint(screen, 0.25 / controller.term.cols, 0.5 / controller.term.rows);
  const end = pagePoint(screen, 13.25 / controller.term.cols, 1.5 / controller.term.rows);
  await mouse.press(start.x, start.y);
  await mouse.moveTo(end.x, end.y);
  await mouse.release(end.x, end.y);
  expect(controller.getAgentSelection()).toBe("中文 output\n  second line");
  expect(controller.term.getSelection()).toBe("");
  expect(writes.length).toBeGreaterThan(0);
  writes.length = 0;
  await page
    .getByRole("tablist")
    .getByRole("button", { name: "Agent prompt", exact: true })
    .click();
  await page.getByRole("button", { name: "Add terminal selection", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Agent prompt", exact: true }))
    .toHaveValue("中文 output\n  second line");
  expect(writes).toHaveLength(0);
});

it("keeps Shift selection visible when moving over a TUI that tracks all mouse motion", async () => {
  const controller = await fixture();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await new Promise<void>((resolve) =>
    controller.term.write("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[Hstable selection", resolve),
  );
  const screen = controller.term.element!.querySelector(".xterm-screen")!;
  const start = pagePoint(screen, 0.25 / controller.term.cols, 0.5 / controller.term.rows);
  const end = pagePoint(screen, 16.25 / controller.term.cols, 0.5 / controller.term.rows);
  await mouse.press(start.x, start.y, 8);
  await mouse.moveTo(end.x, end.y);
  await mouse.release(end.x, end.y, 8);
  await expect.poll(() => controller.term.getSelection()).toBe("stable selection");
  writes.length = 0;
  await mouse.moveTo(end.x + 20, end.y + 40);
  await expect.poll(() => controller.term.getSelection()).toBe("stable selection");
  expect(writes).toHaveLength(0);
  // An ordinary new gesture still goes to the mouse-owning application.
  await mouse.press(start.x, start.y);
  await mouse.release(start.x, start.y);
  await expect.poll(() => writes.length > 0).toBe(true);
});

it("quotes a Shift-drag selection from a mouse-owning TUI after its screen redraws", async () => {
  const controller = await fixture();
  await page
    .getByRole("dialog", { name: "Coding Agents" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await new Promise<void>((resolve) =>
    controller.term.write(
      "\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H中文 output\r\n  second line",
      resolve,
    ),
  );
  const screen = controller.term.element!.querySelector(".xterm-screen")!;
  const start = pagePoint(screen, 0.25 / controller.term.cols, 0.5 / controller.term.rows);
  const end = pagePoint(screen, 13.25 / controller.term.cols, 1.5 / controller.term.rows);
  await mouse.press(start.x, start.y, 8);
  await mouse.moveTo(end.x, end.y);
  await mouse.release(end.x, end.y, 8);
  const selected = controller.term.getSelection();
  expect(selected.replace(/\r\n/g, "\n")).toBe("中文 output\n  second line");
  await new Promise<void>((resolve) => controller.term.write("\x1b[2J\x1b[Hnew output", resolve));
  await page.getByRole("button", { name: "Coding Agents", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Agent prompt", exact: true });
  await editor.fill("Explain this:");
  await page.getByRole("button", { name: "Add terminal selection", exact: true }).click();
  await expect.element(editor).toHaveValue("Explain this:\n\n中文 output\n  second line");
  expect(writes).toHaveLength(0);
  const original = useStore.getState().tabs[0];
  useStore.setState({
    tabs: [
      original,
      {
        ...original,
        info: { ...original.info, id: "agent-other", name: "Other terminal" },
        number: 2,
      },
    ],
  });
  await ensureController("agent-other");
  await userEvent.selectOptions(
    page.getByRole("combobox", { name: "Terminal", exact: true }),
    "agent-other",
  );
  await page.getByRole("button", { name: "Add terminal selection", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Select text in the terminal first");
  await expect.element(editor).toHaveValue("");
  await userEvent.selectOptions(
    page.getByRole("combobox", { name: "Terminal", exact: true }),
    "agent-fixture",
  );
  await expect.element(editor).toHaveValue("Explain this:\n\n中文 output\n  second line");
  controller.setLocked(true);
  controller.setLocked(false);
  useStore.setState((state) => ({
    tabs: state.tabs.map((tab) => ({ ...tab, rows: tab.rows + 1 })),
  }));
  await twoFrames();
  await page.getByRole("button", { name: "Add terminal selection", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Select text in the terminal first");
  await expect.element(editor).toHaveValue("Explain this:\n\n中文 output\n  second line");
});

it("keeps generic input controls and removes agent history and recovery", async () => {
  await fixture();
  expect(page.getByRole("button", { name: "History", exact: true }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Resume", exact: true }).elements()).toHaveLength(0);
  expect(
    page.getByRole("button", { name: "Open agent history", exact: true }).elements(),
  ).toHaveLength(0);
  expect(
    page.getByRole("button", { name: "Resume an agent session", exact: true }).elements(),
  ).toHaveLength(0);
  expect(page.getByRole("combobox", { name: "Tool", exact: true }).elements()).toHaveLength(0);
  await page.getByRole("button", { name: "Add terminal selection", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Select text in the terminal first");
  await expect
    .element(page.getByRole("button", { name: "Add file or image reference" }))
    .toBeVisible();
});

it("inserts one bracketed prompt with paragraphs and no trailing submit", async () => {
  await fixture();
  await page
    .getByRole("textbox", { name: "Agent prompt", exact: true })
    .fill("first paragraph\n\n  ```ts\n  keep indentation\n  ```");
  await page
    .getByRole("dialog", { name: "Coding Agents" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Coding Agents", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Agent prompt", exact: true }))
    .toHaveValue("first paragraph\n\n  ```ts\n  keep indentation\n  ```");
  await page.getByRole("button", { name: "Insert into terminal", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    id: "agent-fixture",
    data: "\x1b[200~first paragraph\r\r  ```ts\r  keep indentation\r  ```\x1b[201~",
  });
  expect(document.querySelector(".agent-dialog")).toBeNull();
});

it("refuses prompt input after disconnect, and keeps Ctrl+Tab in the chosen agent", async () => {
  const controller = await fixture();
  await page
    .getByRole("checkbox", { name: "Send Ctrl+Tab / Ctrl+Shift+Tab to this agent" })
    .click();
  await page
    .getByRole("dialog", { name: "Coding Agents" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  controller.focus();
  await userEvent.keyboard("{Control>}{Tab}{/Control}");
  expect(writes.some((row) => row.data === "\x1b[9;5u")).toBe(true);
  await page.getByRole("button", { name: "Coding Agents", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Agent prompt", exact: true })
    .fill("do not send to a closed session");
  controller.setLocked(true);
  expect(controller.agentKeyPassthrough).toBe(false);
  useStore.setState((state) => ({ tabs: state.tabs.map((tab) => ({ ...tab, state: "closed" })) }));
  await expect
    .element(page.getByRole("button", { name: "Insert into terminal", exact: true }))
    .toBeDisabled();
});

it("keeps agent Alt+Up separate from shell word-motion compatibility", async () => {
  const controller = await fixture();
  await page
    .getByRole("dialog", { name: "Coding Agents" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await new Promise<void>((resolve) => controller.term.write("alice@fixture:~/repo$ ", resolve));
  expect(controller.noteCommandSent("pi")).toBe(true);
  controller.focus();
  writes.length = 0;
  await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
  expect(writes.some((row) => row.data === "\x1b[1;3A")).toBe(true);
  expect(writes.some((row) => row.data === "\x1b[1;5A")).toBe(false);
});

it("shows the actual remote global and project exit policies and saves only the chosen file", async () => {
  await fixture("ssh");
  await page.getByRole("button", { name: "Compatibility", exact: true }).click();
  await userEvent.selectOptions(page.getByRole("combobox", { name: "Tool", exact: true }), "pi");
  await page.getByRole("button", { name: "Inspect selected host" }).click();
  await expect
    .element(page.getByText("fullscreenExitOutput: transcript", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("fullscreenExitOutput: resume-hint", { exact: true }))
    .toBeVisible();
  await page.screenshot({ path: "../../artifacts/usability/agents-diagnostics.png" });
  await page.getByRole("button", { name: "Use resume hint on exit" }).click();
  await expect.poll(() => requests.some((row) => row.command === "project_write_text")).toBe(true);
  const saved = requests.find((row) => row.command === "project_write_text")!;
  expect(saved.id).toBe("agent-fixture");
  expect((saved.request as { path: string }).path).toBe("/project/repo/.pi/settings.json");
});

it("adds a remote image reference only after its upload completes", async () => {
  await fixture("ssh");
  await expect
    .element(page.getByRole("textbox", { name: "Project directory" }))
    .toHaveValue("/project/repo");
  await page.getByRole("button", { name: "Add file or image reference" }).click();
  await expect.poll(() => uploadDone !== null).toBe(true);
  await expect
    .element(page.getByRole("textbox", { name: "Agent prompt", exact: true }))
    .toHaveValue("");
  uploadDone!();
  await expect
    .poll(
      () =>
        (
          page
            .getByRole("textbox", { name: "Agent prompt", exact: true })
            .element() as HTMLTextAreaElement
        ).value,
    )
    .toContain("/project/repo/.edgeterm-attachments/");
});

it("keeps all agent actions reachable across the responsive breakpoint", async () => {
  await fixture();
  for (const width of [599, 600, 601, 900, 1280]) {
    await page.viewport(width, 800);
    await twoFrames();
    const box = document.querySelector(".agent-dialog")!.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    await expect
      .element(page.getByRole("button", { name: "Insert into terminal", exact: true }))
      .toBeVisible();
    await page.screenshot({ path: `../../artifacts/usability/agents-${width}.png` });
  }
  await page.viewport(900, 560);
  await twoFrames();
  useStore.getState().setLanguage("zh-CN");
  useStore.getState().setTheme("light");
  await twoFrames();
  await page
    .getByRole("button", { name: "放入终端输入区", exact: true })
    .element()
    .scrollIntoView();
  await expect
    .element(page.getByRole("button", { name: "放入终端输入区", exact: true }))
    .toBeVisible();
  await page.screenshot({ path: "../../artifacts/usability/agents-900x560-zh-light.png" });
});
