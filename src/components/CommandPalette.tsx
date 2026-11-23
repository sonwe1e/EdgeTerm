import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import {
  groupCommands,
  loadRecents,
  matchRanges,
  paletteGroupLabels,
  pushRecent,
  rankCommands,
  saveRecents,
  type PaletteCommand,
} from "../commandPalette";
import { useT } from "../useT";
import { Icon } from "./icons";
import { ModalDialog } from "./ModalDialog";

/**
 * The command palette: ⇧⌘P / Ctrl+Shift+P opens one field over everything the
 * app can do — the shortcut table, the panels, the open tabs, the saved
 * sessions, the four themes and the settings dialogs.
 *
 * The ranking lives in commandPalette.ts and is unit-tested there. This file
 * owns the interaction: the dialog boundary (Escape, backdrop, focus return
 * and Tab containment come from ModalDialog), the list's keyboard model
 * (arrows wrap, Home/End jump, Enter runs) and the ARIA combobox/listbox
 * pairing that lets assistive technology read the highlighted row.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** The catalogue for the current app state, rebuilt by App while it is open. */
  commands: PaletteCommand[];
}

const optionId = (index: number): string => "command-palette-option-" + index;

/** The label with the matched characters wrapped, so a fuzzy hit is visible. */
const highlighted = (label: string, query: string): ReactNode => {
  const ranges = matchRanges(label, query);
  if (ranges.length === 0) return label;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(label.slice(cursor, start));
    parts.push(<mark key={start}>{label.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < label.length) parts.push(label.slice(cursor));
  return parts;
};

export function CommandPalette({ open, onClose, commands }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const inputRef = useRef<HTMLInputElement>(null);

  // Each open starts from a clean field: a query left over from the previous
  // visit would hide the very command the reader is looking for.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setRecents(loadRecents());
  }, [open]);

  const ranked = useMemo(() => rankCommands(commands, query, recents), [commands, query, recents]);

  // One heading per group, rows of the same group kept together. The flattened
  // order below is what the arrow keys walk and what the option ids number, so
  // a row is always addressed by the position the reader sees.
  const sections = useMemo(() => groupCommands(ranked, query), [ranked, query]);
  const labels = useMemo(() => paletteGroupLabels(t), [t]);
  const flat = useMemo(() => sections.flatMap((section) => section.commands), [sections]);
  const indexById = useMemo(
    () => new Map(flat.map((command, index) => [command.id, index])),
    [flat],
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  // A result list that shrank under the pointer must not leave the selection
  // past its end.
  useEffect(() => {
    setActive((value) => (value >= flat.length ? 0 : value));
  }, [flat.length]);

  // The pointed row must stay visible while the arrow keys walk past the fold.
  useEffect(() => {
    const option = document.getElementById(optionId(active));
    // jsdom does not implement scrolling; the browser path is the real one.
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [active, ranked]);

  const run = useCallback(
    (command: PaletteCommand) => {
      const next = pushRecent(loadRecents(), command.id);
      saveRecents(next);
      setRecents(next);
      // Close first: a command that opens a dialog must not stack two modals,
      // and the focus ModalDialog returns should land on the app, not on a
      // dialog that is about to open.
      onClose();
      command.run();
    },
    [onClose],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Tab") {
      // Tab is not a navigation key here: the field is the only focus stop
      // and the reader is modal. Leaving closes, the way Escape does.
      event.preventDefault();
      onClose();
      return;
    }
    const count = flat.length;
    if (count === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => (value + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => (value - 1 + count) % count);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(count - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = flat[active];
      if (command) run(command);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      bare
      contentClassName="command-palette"
      ariaLabel={t("palette.title")}
      initialFocus=".command-palette-input"
      onKeyDown={onKeyDown}
    >
      <div className="command-palette-field">
        <Icon name="search" className="command-palette-icon" />
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("palette.placeholder")}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-autocomplete="list"
          aria-activedescendant={flat.length > 0 ? optionId(active) : undefined}
          aria-label={t("palette.title")}
          autoComplete="off"
          spellCheck={false}
        />
        <kbd className="command-palette-esc">Esc</kbd>
      </div>

      <div
        className="command-palette-list"
        id="command-palette-list"
        role="listbox"
        aria-label={t("palette.title")}
      >
        {sections.map((section) => (
          <div
            className="command-palette-group"
            role="group"
            aria-label={labels[section.id]}
            key={section.id}
          >
            <div className="command-palette-heading" aria-hidden="true">
              {labels[section.id]}
            </div>
            {section.commands.map((command) => {
              const index = indexById.get(command.id) ?? 0;
              return (
                <div
                  key={command.id}
                  id={optionId(index)}
                  className={"command-palette-option" + (index === active ? " is-active" : "")}
                  role="option"
                  aria-selected={index === active}
                  onPointerMove={() => setActive(index)}
                  onClick={() => run(command)}
                >
                  <span className="command-palette-label">{highlighted(command.label, query)}</span>
                  {command.hint && <span className="command-palette-hint">{command.hint}</span>}
                  {command.chord && <kbd className="command-palette-chord">{command.chord}</kbd>}
                </div>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && (
          <p className="command-palette-empty" role="status">
            {t("palette.noMatch", { query })}
          </p>
        )}
      </div>

      <div className="command-palette-footer">
        <span>{t("palette.footer")}</span>
        <span>{t("palette.count", { count: flat.length })}</span>
      </div>
    </ModalDialog>
  );
}
