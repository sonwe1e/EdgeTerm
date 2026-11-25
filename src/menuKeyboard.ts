const EXTERNAL_KEYBOARD_SURFACES = 'dialog[open], .context-menu, [role="dialog"]';
const ALL_KEYBOARD_SURFACES = `${EXTERNAL_KEYBOARD_SURFACES}, .menu-dropdown, .menu-item.is-open`;

/**
 * Whether a key event's target belongs to a surface that owns the keyboard: a
 * native dialog, a context menu, an open menu-bar dropdown (including its
 * portaled submenus), or the Sender's hand-rolled popover.
 *
 * Window-level shortcut handlers must consult this. Without it a chord pressed
 * while a menu is open runs the command and leaves the menu standing over the
 * result: the menu keeps its stale anchor, and its entries still carry the
 * state captured when it opened - so a reader can click a row that describes a
 * different session than the one now on screen.
 */
export function surfaceOwnsKeyboard(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ALL_KEYBOARD_SURFACES) !== null;
}

/**
 * Surfaces external to the menubar itself (native dialogs, context menus,
 * hand-rolled dialogs) that must block Alt / F10 from opening or toggling the
 * menubar underneath them, while still allowing Alt / F10 inside an open
 * menubar dropdown to toggle the menubar closed.
 */
export function externalSurfaceOwnsKeyboard(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EXTERNAL_KEYBOARD_SURFACES) !== null;
}
