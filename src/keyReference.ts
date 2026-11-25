import type { MessageKey } from "./i18n";
import { IS_MAC } from "./platform";

/**
 * Keys that belong to the surface under the pointer rather than to a rebindable
 * command: F2 renames the selected row, Delete removes it, Alt opens the menu
 * bar. They cannot be reassigned (see `chordProblem`), and until now the
 * shortcut dialog listed only the tab-number keys, so these had to be found by
 * trying. The table is read-only; nothing here changes a binding.
 *
 * `needles` are literals that must still exist in `source`. The test reads
 * that file, so a handler that moves to another key cannot leave this table
 * claiming the old one.
 */
interface KeyReferenceEntry {
  /** The keys as the dialog shows them, in this platform's spelling. */
  keys: string[];
  /** The file that handles them; relative to the repository root. */
  source: string;
  needles: string[];
  labelKey: MessageKey;
}

interface KeyReferenceGroup {
  titleKey: MessageKey;
  entries: KeyReferenceEntry[];
}

const FILER = "src/components/panels/FilerPanel.tsx";
const MENU_BAR = "src/components/MenuBar.tsx";

export const KEY_REFERENCE: KeyReferenceGroup[] = [
  {
    titleKey: "keys.group.filer",
    entries: [
      { keys: ["F2"], source: FILER, needles: ['"F2"'], labelKey: "filer.rename" },
      {
        keys: ["Delete"],
        source: FILER,
        needles: ['"Delete"'],
        labelKey: "common.delete",
      },
      {
        keys: ["Backspace"],
        source: FILER,
        needles: ['"Backspace"'],
        labelKey: "filer.parentFolder",
      },
      { keys: ["Enter"], source: FILER, needles: ['"Enter"'], labelKey: "filer.open" },
      {
        keys: [IS_MAC ? "⌘A" : "Ctrl+A"],
        source: FILER,
        needles: ['key.toLowerCase() === "a"'],
        labelKey: "keys.selectAll",
      },
      {
        // Every platform reports the keyboard menu key as F10 with Shift, or
        // as ContextMenu; the handler accepts both (FilerPanel.tsx:545).
        keys: ["Shift+F10"],
        source: FILER,
        needles: ['"ContextMenu"', '"F10"'],
        labelKey: "keys.contextMenu",
      },
    ],
  },
  {
    titleKey: "keys.group.menus",
    entries: [
      {
        // F10 alone cannot be listed here: xterm claims it inside the terminal
        // and sends the escape sequence to the program, so the menu never sees
        // it. Alt works from the terminal because it is tracked on capture.
        keys: ["Alt"],
        source: MENU_BAR,
        needles: ['"Alt"'],
        labelKey: "keys.menubar",
      },
    ],
  },
];
