import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Icon, type IconName } from "./icons";
import { submenuKey, useSubmenuHover } from "./submenuHover";

/**
 * Which control a checkable entry draws in the leading column: a box for an
 * independent on / off setting, a radio for one choice out of a set.
 */
export type MenuMark = "check" | "radio";

export interface MenuAction {
  label: string;
  action?: () => void;
  disabled?: boolean;
  /** Destructive entries are tinted red. */
  danger?: boolean;
  /** Marks the entry as a choice, and says whether it is the chosen one. */
  checked?: boolean;
  /** The control shape a checkable entry draws; a box by default. */
  mark?: MenuMark;
  /** A Codicon in the leading column, before the label. */
  icon?: IconName;
  /**
   * A CSS color drawn as a dot before the label, for color choices; null
   * draws the empty ring of a "no color" choice.
   */
  swatch?: string | null;
  /** The key combination that runs the same command, shown at the right. */
  shortcut?: string;
  /** Extra left padding in tree levels, for nested choices in a submenu. */
  indent?: number;
  /** Nested entries opened on hover. */
  children?: MenuItem[];
}

/** A quiet caption over the entries that follow, e.g. what a choice decides. */
export interface MenuHeading {
  heading: string;
}

export type MenuItem = MenuAction | MenuHeading | "separator";

interface Props {
  /** Viewport coordinates of the pointer when the menu was requested. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /**
   * Which edge of the menu sits at `x`. "right" is for dropdowns hanging off
   * a button near the right side of the screen.
   */
  align?: "left" | "right";
  /** Extra classes, e.g. to cap the height of a long, scrollable list. */
  className?: string;
}

/** Approximate submenu width, used to decide which side it opens on. */
const SUBMENU_WIDTH = 200;
const EDGE_MARGIN = 6;

const MENU_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
const levelItems = (level: HTMLElement | null) =>
  [...(level?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])].filter(
    (item) => item.closest(".menu-dropdown") === level && !item.matches(":disabled"),
  );

function isAction(item: MenuItem): item is MenuAction {
  return typeof item !== "string" && "label" in item;
}

/** What the leading-column rule reads: an icon, a check state, nothing else. */
interface LeadingCandidate {
  icon?: IconName;
  checked?: boolean;
}

/**
 * Whether one menu level needs the leading column. Any entry with an icon
 * or a check mark gives every row of that level the column, so the labels
 * share one left edge; levels without either stay compact. Shared with the
 * menubar so both surfaces answer the question the same way.
 *
 * Takes `unknown[]` because the menubar and the context menus carry their
 * own entry types (entries, headings, separators); the rule only looks at
 * two fields, and both call sites are already typed where the items are
 * written.
 */
export function hasLeading(items: readonly unknown[]): boolean {
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { icon, checked } = item as LeadingCandidate;
    return icon !== undefined || checked !== undefined;
  });
}

/**
 * The selection column of a dropdown entry. A checkable entry always draws
 * its control — an empty box or radio when it is off — so the rows that are
 * choices read as choices before anything is picked; entries that are plain
 * commands get a same-width blank so every label shares one left edge.
 * Shared with the menubar's dropdowns.
 */
export function MenuCheck({ checked, mark = "check" }: { checked?: boolean; mark?: MenuMark }) {
  if (checked === undefined) {
    return <span className="menu-check" aria-hidden="true" />;
  }
  return (
    <span className={`menu-check is-${mark}${checked ? " is-checked" : ""}`} aria-hidden="true">
      {mark === "check" && checked && <Icon name="check" />}
    </span>
  );
}

/** The ARIA role of an entry: a checkbox, a radio, or a plain command. */
export function menuRole(item: {
  checked?: boolean;
  mark?: MenuMark;
}): "menuitem" | "menuitemcheckbox" | "menuitemradio" {
  if (item.checked === undefined) return "menuitem";
  return item.mark === "radio" ? "menuitemradio" : "menuitemcheckbox";
}

/** The leading column: a choice's check mark, else the entry's icon. */
export function MenuLeading({
  entry,
}: {
  entry: { icon?: IconName; checked?: boolean; mark?: MenuMark };
}) {
  // A choice owns the column: drawing an icon instead would hide the state
  // the row exists to show, so a checkable entry never yields to one.
  if (entry.checked === undefined && entry.icon) {
    return (
      <span className="menu-icon" aria-hidden="true">
        <Icon name={entry.icon} />
      </span>
    );
  }
  return <MenuCheck checked={entry.checked} mark={entry.mark} />;
}

/**
 * A right-click menu anchored at a viewport point. It reuses the menubar's
 * dropdown styling, keeps itself inside the window, and closes on any click
 * outside, Escape, scrolling, resizing or the window losing focus — the same
 * moments a native menu would go away.
 */
export function ContextMenu({ x, y, items, onClose, align = "left", className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{
    left: number;
    top: number;
    flipped: boolean;
  }>({ left: x, top: y, flipped: false });
  const submenu = useSubmenuHover();
  const [keyboardOpen, setKeyboardOpen] = useState<string | null | undefined>(undefined);
  const focusFrame = useRef(0);
  const shown = (path: string) =>
    keyboardOpen === undefined
      ? submenu.isOpen(path)
      : keyboardOpen === path || keyboardOpen?.startsWith(`${path}.`) === true;

  // Right-clicking a tab does not blur xterm. Own focus before the next key
  // can reach the terminal; only return it if no other control took focus.
  useLayoutEffect(() => {
    const element = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    (levelItems(element)[0] ?? element)?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(focusFrame.current);
      if (
        opener?.isConnected &&
        (element?.contains(document.activeElement) || document.activeElement === document.body)
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const focusInto = (path: string) => {
    setKeyboardOpen(path);
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      const level =
        ref.current?.querySelector<HTMLElement>(`[data-submenu-key="${path}"] > .menu-submenu`) ??
        null;
      levelItems(level)[0]?.focus({ preventScroll: true });
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Even unhandled keys must not run window/terminal shortcuts underneath.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
      return;
    }
    const item = (event.target as HTMLElement).closest<HTMLElement>(MENU_ITEMS);
    const level = item?.closest<HTMLElement>(".menu-dropdown") ?? null;
    const entries = levelItems(level);
    const index = item ? entries.indexOf(item) : -1;
    if (index < 0) return;
    const focus = (next: HTMLElement) => {
      event.preventDefault();
      next.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown":
        return focus(entries[(index + 1) % entries.length]);
      case "ArrowUp":
        return focus(entries[(index - 1 + entries.length) % entries.length]);
      case "Home":
        return focus(entries[0]);
      case "End":
        return focus(entries[entries.length - 1]);
      case "ArrowRight": {
        event.preventDefault();
        const path = item?.parentElement?.dataset.submenuKey;
        if (path !== undefined) focusInto(path);
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        const parent = level?.closest<HTMLElement>(".menu-submenu-entry");
        if (!parent) return;
        const path = parent.dataset.submenuKey!;
        setKeyboardOpen(path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : null);
        parent.querySelector<HTMLElement>(":scope > .menu-entry")?.focus({ preventScroll: true });
        return;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        item?.click();
    }
  };

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { offsetWidth: width, offsetHeight: height } = element;
    const maxLeft = window.innerWidth - width - EDGE_MARGIN;
    const maxTop = window.innerHeight - height - EDGE_MARGIN;
    const anchorLeft = align === "right" ? x - width : x;
    const left = Math.max(EDGE_MARGIN, Math.min(anchorLeft, maxLeft));
    const top = Math.max(EDGE_MARGIN, Math.min(y, maxTop));
    // Menus opened from the Filer sit at the right edge, so their submenus
    // have to open leftwards to stay visible.
    const flipped = left + width + SUBMENU_WIDTH > window.innerWidth;
    setPlacement({ left, top, flipped });
  }, [x, y, items, align]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onFocus = (event: FocusEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    // Capture phase: a scroll anywhere (the panel body included) would leave
    // the fixed-position menu floating away from its row.
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("scroll", onClose, true);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("scroll", onClose, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const renderItems = (level: MenuItem[], parent?: string) => {
    const showLeading = hasLeading(level);
    return level.map((item, index) => {
      if (item === "separator") {
        return <div key={`sep-${index}`} className="menu-separator" />;
      }
      if (!isAction(item)) {
        return (
          <div key={`heading-${index}`} className="menu-heading" role="presentation">
            {item.heading}
          </div>
        );
      }
      const key = `${item.label}-${index}`;
      if (item.children) {
        const path = submenuKey(parent, index);
        const hover = submenu.entryProps(path);
        const isOpen = shown(path);
        return (
          <div
            key={key}
            className={`menu-submenu-entry${isOpen ? " is-open" : ""}`}
            data-submenu-key={path}
            {...hover}
            onMouseEnter={() => {
              if (item.disabled) return;
              setKeyboardOpen(undefined);
              hover.onMouseEnter();
            }}
          >
            <button
              type="button"
              className="menu-entry"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => focusInto(path)}
            >
              {showLeading && <MenuLeading entry={item} />}
              <span className="menu-entry-label">{item.label}</span>
              <span className="menu-submenu-arrow" aria-hidden="true">
                <Icon name="chevron-right" />
              </span>
            </button>
            <div className="menu-dropdown menu-submenu" role="menu">
              {renderItems(item.children, path)}
            </div>
          </div>
        );
      }
      return (
        <button
          key={key}
          type="button"
          tabIndex={-1}
          role={menuRole(item)}
          aria-checked={item.checked !== undefined ? item.checked : undefined}
          className={[
            "menu-entry",
            item.checked ? "is-checked" : "",
            item.danger ? "is-danger" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={item.disabled}
          style={item.indent ? ({ paddingLeft: 8 + item.indent * 14 } as CSSProperties) : undefined}
          onClick={() => {
            onClose();
            item.action?.();
          }}
        >
          {showLeading && <MenuLeading entry={item} />}
          {item.swatch !== undefined && (
            <span
              className={`menu-swatch${item.swatch === null ? " is-empty" : ""}`}
              style={item.swatch ? { background: item.swatch } : undefined}
              aria-hidden="true"
            />
          )}
          <span className="menu-entry-label">{item.label}</span>
          {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
        </button>
      );
    });
  };

  return (
    <div
      ref={ref}
      className={[
        "menu-dropdown",
        "context-menu",
        align === "right" ? "is-right" : "",
        placement.flipped ? "is-flipped" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => event.stopPropagation()}
      style={{ left: placement.left, top: placement.top }}
      onContextMenu={(event) => event.preventDefault()}
      {...submenu.rootProps}
    >
      {renderItems(items)}
    </div>
  );
}
