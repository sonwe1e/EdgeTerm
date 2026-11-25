/**
 * Shared placement engine for portaled submenus in both `ContextMenu` and
 * `MenuBar`. Submenus render as portals outside any scrolling parent
 * `.menu-dropdown` so CSS `overflow-y: auto` (which forces `overflow-x: auto`)
 * can never trap or clip a submenu inside its parent's scrollbox.
 */

export const SUBMENU_GAP = 4;
export const EDGE_MARGIN = 6;

/** Parent branch path for a dot-delimited submenu key, or null at top level. */
export const parentPath = (path: string): string | null =>
  path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : null;

/**
 * Portal container for floating submenus. `.app` carries no transform/filter
 * and holds the live `--panel-font-size` ladder, so direct children escape
 * parent menu scrollports without losing interface typography tokens.
 */
export const submenuPortalHost = (root: HTMLElement | null): HTMLElement =>
  root?.closest<HTMLElement>(".app") ?? document.body;

/** Whether any menu panel currently has a running CSS animation. */
export const hasRunningAnimations = (elements: readonly (HTMLElement | null)[]): boolean =>
  elements.some((element) =>
    element?.getAnimations?.().some((animation) => animation.playState === "running"),
  );

export interface PositionSubmenusArgs {
  root: HTMLElement | null;
  triggerRows: ReadonlyMap<string, HTMLElement>;
  panels: ReadonlyMap<string, HTMLElement>;
  /** Whether the root menu already prefers opening submenus leftward. */
  rootFlipped?: boolean;
  /** Called with the shallowest path whose trigger scrolled out of view. */
  onHidden?: (path: string) => void;
}

/**
 * Measures and places every currently mounted portaled submenu against its
 * trigger row and parent scrollport. Ancestors are positioned before
 * descendants so each nested panel reads this frame's parent geometry.
 */
export function positionPortalSubmenus({
  root,
  triggerRows,
  panels,
  rootFlipped = false,
  onHidden,
}: PositionSubmenusArgs): void {
  if (!root || panels.size === 0) return;
  const rootStyle = getComputedStyle(root);
  const levels = [...panels].sort(([a], [b]) => a.length - b.length);
  let hiddenPath: string | undefined;

  for (const [path, panel] of levels) {
    const entry = triggerRows.get(path);
    const owner = entry?.closest<HTMLElement>(".menu-dropdown");
    if (!entry || !owner) continue;

    const anchor = entry.getBoundingClientRect();
    const ownerBox = owner.getBoundingClientRect();
    const scale = owner.offsetHeight > 0 ? ownerBox.height / owner.offsetHeight : 1;
    const visibleTop = ownerBox.top + owner.clientTop * scale;
    const visibleBottom = visibleTop + owner.clientHeight * scale;
    if (
      owner.style.visibility === "hidden" ||
      (owner.clientHeight > 0 && (anchor.bottom <= visibleTop || anchor.top >= visibleBottom))
    ) {
      // A scrolled-away trigger must not leave an actionable floating submenu
      // orphaned over the workspace. Hide synchronously before React removes it.
      panel.style.visibility = "hidden";
      hiddenPath ??= path;
      if (panel.contains(document.activeElement)) owner.focus({ preventScroll: true });
      continue;
    }

    panel.style.fontFamily = rootStyle.fontFamily;
    panel.style.fontSize = rootStyle.fontSize;
    panel.style.lineHeight = rootStyle.lineHeight;

    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const leftRoom = anchor.left - EDGE_MARGIN;
    const rightRoom = window.innerWidth - EDGE_MARGIN - anchor.right;
    const preferLeft = owner.dataset.side === "left" || (owner === root && rootFlipped);
    const flipped = preferLeft
      ? leftRoom >= width + SUBMENU_GAP || rightRoom < width + SUBMENU_GAP
      : rightRoom < width + SUBMENU_GAP && leftRoom > rightRoom;
    const wantedLeft = flipped ? anchor.left - width - SUBMENU_GAP : anchor.right + SUBMENU_GAP;
    const padding = Number.parseFloat(getComputedStyle(panel).paddingTop) || 0;
    const wantedTop = anchor.top - panel.clientTop - padding;

    panel.style.left = `${Math.max(
      EDGE_MARGIN,
      Math.min(wantedLeft, window.innerWidth - width - EDGE_MARGIN),
    )}px`;
    panel.style.top = `${Math.max(
      EDGE_MARGIN,
      Math.min(wantedTop, window.innerHeight - height - EDGE_MARGIN),
    )}px`;
    panel.dataset.side = flipped ? "left" : "right";
    entry.dataset.submenuSide = panel.dataset.side;
    panel.style.visibility = "visible";
  }

  if (hiddenPath !== undefined) onHidden?.(hiddenPath);
}
