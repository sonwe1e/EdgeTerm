import type { Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { claimEditorState, rememberEditorState } from "./editorState";

/**
 * The editor bundle is loaded on the first open document, not with the
 * window: CodeMirror and its language packages are the largest optional
 * dependency, and a terminal-only session never needs them.
 */

export interface EditorHandle {
  view: EditorView;
  setCallbacks: (callbacks: {
    onChange: (content: string) => void;
    onSave: () => void;
  }) => void;
  setTheme: (dark: boolean, fontSize: number) => void;
  setReadOnly: (readOnly: boolean) => void;
  /** Replace the text from outside the editor (server reload). History is dropped. */
  setContent: (content: string) => void;
  revealLine: (line: number) => void;
  focus: () => void;
  /** Keep the document state for this id, then destroy the DOM view. */
  destroy: () => void;
  /** Destroy without keeping state: the view was never shown. */
  discard: () => void;
}

/**
 * The visible view's callbacks. A reused `EditorState` keeps the listener it
 * was created with, so the listener reads this instead of closing over the
 * component instance that happened to create it.
 */
let active: {
  owner: object;
  onChange: (content: string) => void;
  onSave: () => void;
} | null = null;

export function languageFor(path: string): string {
  const name = path.toLowerCase().split("/").pop() ?? path;
  if (name.endsWith(".py") || name.endsWith(".pyi")) return "python";
  if (name.endsWith(".json") || name.endsWith(".jsonc") || name.endsWith(".ipynb")) return "json";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".toml") || name.endsWith(".ini") || name.endsWith(".cfg")) return "ini";
  if (
    name.endsWith(".js") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs") ||
    name.endsWith(".jsx") ||
    name.endsWith(".ts") ||
    name.endsWith(".tsx")
  ) {
    return "javascript";
  }
  if (
    name.endsWith(".sh") ||
    name.endsWith(".bash") ||
    name.endsWith(".zsh") ||
    name.endsWith(".fish") ||
    name === "dockerfile" ||
    name === "makefile"
  ) {
    return "shell";
  }
  return "text";
}

const darkColors = {
  keyword: "#c586c0",
  string: "#ce9178",
  number: "#b5cea8",
  comment: "#6a9955",
  function: "#dcdcaa",
  type: "#4ec9b0",
  variable: "#9cdcfe",
  property: "#9cdcfe",
  operator: "#d4d4d4",
  meta: "#569cd6",
  invalid: "#f85149",
};

const lightColors = {
  keyword: "#af00db",
  string: "#a31515",
  number: "#098658",
  comment: "#008000",
  function: "#795e26",
  type: "#267f99",
  variable: "#001080",
  property: "#0451a5",
  operator: "#000000",
  meta: "#0000ff",
  invalid: "#cd3131",
};

async function loadModules() {
  const [
    state,
    view,
    commands,
    language,
    search,
    python,
    json,
    yaml,
    javascript,
    legacy,
    toml,
    highlight,
  ] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
    import("@codemirror/search"),
    import("@codemirror/lang-python"),
    import("@codemirror/lang-json"),
    import("@codemirror/lang-yaml"),
    import("@codemirror/lang-javascript"),
    import("@codemirror/legacy-modes/mode/shell"),
    import("@codemirror/legacy-modes/mode/toml"),
    import("@lezer/highlight"),
  ]);
  return {
    state,
    view,
    commands,
    language,
    search,
    python,
    json,
    yaml,
    javascript,
    legacy,
    toml,
    highlight,
  };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

/** Compartments are tokens in a state, so they must be created once: a state
 * saved from an earlier mount can only be reconfigured through the same
 * instances. */
let compartments: {
  theme: Compartment;
  readOnly: Compartment;
  language: Compartment;
} | null = null;

function editorTheme(mods: Modules, dark: boolean, fontSize: number) {
  const { EditorView } = mods.view;
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "var(--bg-terminal)",
        color: "var(--fg)",
        fontSize: `${fontSize}px`,
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.55",
      },
      ".cm-content": { caretColor: "var(--fg)" },
      ".cm-gutters": {
        backgroundColor: "var(--bg-panel)",
        color: "var(--fg-faint)",
        border: "none",
        borderRight: "1px solid var(--border)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--fg) 5%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--fg)",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
        { backgroundColor: "var(--bg-active)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
      ".cm-panels": {
        backgroundColor: "var(--bg-panel-alt)",
        color: "var(--fg)",
        borderBottom: "1px solid var(--border)",
      },
      ".cm-panels input, .cm-panels button": {
        backgroundColor: "var(--bg-field)",
        color: "var(--fg)",
        border: "1px solid var(--border)",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--yellow) 32%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--bg-field)",
        border: "1px solid var(--border)",
        color: "var(--fg-dim)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-menu)",
        border: "1px solid var(--border-menu)",
        color: "var(--fg)",
      },
    },
    { dark },
  );
}

function highlightStyle(mods: Modules, dark: boolean) {
  const { syntaxHighlighting, HighlightStyle } = mods.language;
  const { tags: t } = mods.highlight;
  const colors = dark ? darkColors : lightColors;
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.modifier, t.operatorKeyword], color: colors.keyword },
      { tag: [t.string, t.special(t.string)], color: colors.string },
      { tag: [t.number, t.bool, t.null, t.atom], color: colors.number },
      { tag: [t.lineComment, t.blockComment, t.docComment], color: colors.comment, fontStyle: "italic" },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], color: colors.function },
      { tag: [t.typeName, t.className, t.namespace, t.self], color: colors.type },
      { tag: [t.variableName, t.definition(t.variableName)], color: colors.variable },
      { tag: [t.propertyName, t.attributeName], color: colors.property },
      { tag: [t.operator, t.punctuation, t.bracket], color: colors.operator },
      { tag: [t.meta, t.processingInstruction, t.annotation], color: colors.meta },
      { tag: [t.invalid, t.deleted], color: colors.invalid },
      { tag: [t.heading, t.strong], fontWeight: "600" },
      { tag: [t.emphasis], fontStyle: "italic" },
    ]),
  );
}

function languageExtension(mods: Modules, path: string): Extension {
  const { StreamLanguage } = mods.language;
  switch (languageFor(path)) {
    case "python":
      return mods.python.python();
    case "json":
      return mods.json.json();
    case "yaml":
      return mods.yaml.yaml();
    case "javascript":
      return mods.javascript.javascript({
        typescript: /\.tsx?$/.test(path),
        jsx: /\.(t|j)sx$/.test(path),
      });
    case "shell":
      return StreamLanguage.define(mods.legacy.shell);
    case "ini":
      return StreamLanguage.define(mods.toml.toml);
    default:
      return [];
  }
}

function buildExtensions(
  mods: Modules,
  options: { path: string; dark: boolean; fontSize: number; readOnly: boolean },
) {
  const { EditorState } = mods.state;
  const { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor } = mods.view;
  const { defaultKeymap, history, historyKeymap, indentWithTab } = mods.commands;
  const { indentOnInput, indentUnit, bracketMatching, foldGutter } = mods.language;
  const { search, searchKeymap, highlightSelectionMatches } = mods.search;

  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of("    "),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          active?.onSave();
          return true;
        },
      },
    ]),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    compartments!.language.of(languageExtension(mods, options.path)),
    compartments!.theme.of([
      editorTheme(mods, options.dark, options.fontSize),
      highlightStyle(mods, options.dark),
    ]),
    compartments!.readOnly.of(EditorState.readOnly.of(options.readOnly)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) active?.onChange(update.state.doc.toString());
    }),
  ];
}

export async function createCodeEditor(options: {
  parent: HTMLElement;
  docId: string;
  doc: string;
  path: string;
  dark: boolean;
  fontSize: number;
}): Promise<EditorHandle> {
  const mods = await loadModules();
  const { EditorState } = mods.state;
  const { EditorView } = mods.view;
  compartments ??= {
    theme: new mods.state.Compartment(),
    readOnly: new mods.state.Compartment(),
    language: new mods.state.Compartment(),
  };
  const parts = compartments;
  const settings = {
    path: options.path,
    dark: options.dark,
    fontSize: options.fontSize,
    readOnly: false,
  };

  const saved = claimEditorState(options.docId, options.doc);
  const reusable = saved !== undefined;
  const state = reusable
    ? saved.state
    : EditorState.create({ doc: options.doc, extensions: buildExtensions(mods, settings) });

  const view = new EditorView({ state, parent: options.parent });
  const token = {};
  let alive = true;

  // A recreated state already carries the latest theme; a reused one was
  // built with whatever theme was active last time.
  view.dispatch({
    effects: [
      compartments.theme.reconfigure([
        editorTheme(mods, settings.dark, settings.fontSize),
        highlightStyle(mods, settings.dark),
      ]),
      compartments.readOnly.reconfigure(EditorState.readOnly.of(false)),
    ],
  });
  if (reusable && saved.scrollTop > 0) {
    const scrollTop = saved.scrollTop;
    // After the first layout pass, so the scroller has its full height.
    requestAnimationFrame(() => {
      if (alive) view.scrollDOM.scrollTop = scrollTop;
    });
  }

  return {
    view,
    setCallbacks(callbacks) {
      active = { owner: token, onChange: callbacks.onChange, onSave: callbacks.onSave };
    },
    setTheme(dark, fontSize) {
      settings.dark = dark;
      settings.fontSize = fontSize;
      view.dispatch({
        effects: parts.theme.reconfigure([
          editorTheme(mods, dark, fontSize),
          highlightStyle(mods, dark),
        ]),
      });
    },
    setReadOnly(readOnly) {
      settings.readOnly = readOnly;
      view.dispatch({
        effects: parts.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
      });
    },
    setContent(content) {
      if (view.state.doc.toString() === content) return;
      // A reload is not an edit: rebuilding the state drops the history, so
      // undo cannot walk back into a version the server no longer has.
      view.setState(
        EditorState.create({ doc: content, extensions: buildExtensions(mods, settings) }),
      );
    },
    revealLine(line) {
      if (!Number.isFinite(line) || line < 1) return;
      const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: "center" }),
      });
      view.focus();
    },
    focus() {
      view.focus();
    },
    destroy() {
      if (!alive) return;
      alive = false;
      if (active?.owner === token) active = null;
      // Read the scroll position before the DOM goes away.
      const scrollTop = view.scrollDOM.scrollTop;
      rememberEditorState(options.docId, view.state, scrollTop);
      view.destroy();
    },
    discard() {
      if (!alive) return;
      alive = false;
      if (active?.owner === token) active = null;
      view.destroy();
    },
  };
}
