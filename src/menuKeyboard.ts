/**
 * Whether a key event's target belongs to a surface that owns the keyboard: a
 * native dialog, or one of the three menu surfaces (a context menu, an open
 * menu-bar dropdown, or the Sender's hand-rolled popover), all of which are
 * plain divs in a portal.
 *
 * Window-level shortcut handlers must consult this. Without it a chord pressed
 * while a menu is open runs the command and leaves the menu standing over the
 * result: the menu keeps its stale anchor, and its entries still carry the
 * state captured when it opened - so a reader can click a row that describes a
 * different session than the one now on screen.
 */
export function surfaceOwnsKeyboard(target: EventTarget | null): boolean {
  // [role=dialog] is here for the Sender's hand-rolled popover, which is a
  // div rather than a native dialog. Without it a chord pressed with focus on
  // one of its rows runs the command underneath and leaves the popover
  // standing over the result.
  return (
    target instanceof Element &&
    target.closest('dialog[open], .context-menu, [role="dialog"]') !== null
  );
}
