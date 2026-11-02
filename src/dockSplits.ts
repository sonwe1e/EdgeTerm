import type { PanelDock } from "./panelDock";
import { type PanelName } from "./store";
import { DOCK_SPLITS_KEY } from "./persistKeys";

/**
 * How the panels sharing one dock divide it, as relative weights.
 *
 * The dock is the space; the panels are shares of it. Shares are kept as
 * weights rather than pixels so a dock that is resized by its own splitter
 * keeps the proportion the user arranged, and the same arrangement survives a
 * window whose width no longer fits the pixels exactly.
 */

/** Smallest share a panel keeps when a splitter divides a dock, in pixels. */
export const MIN_SLOT_PX = 72;

export type DockWeights = Partial<Record<PanelName, number>>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A panel's weight, with the unset and unusable cases reading as "even". */
export function weightOf(weights: DockWeights, panel: PanelName): number {
  const value = weights[panel];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

function totalWeight(panels: readonly PanelName[], weights: DockWeights): number {
  return panels.reduce((sum, panel) => sum + weightOf(weights, panel), 0);
}

/** How many pixels one panel takes out of `extent` under these weights. */
export function panelSize(
  panels: readonly PanelName[],
  weights: DockWeights,
  panel: PanelName,
  extent: number,
): number {
  const total = totalWeight(panels, weights);
  if (extent <= 0 || total <= 0) return 0;
  return (extent * weightOf(weights, panel)) / total;
}

/** The arrangement nobody arranged: every panel in the dock shares alike. */
export function equalWeights(panels: readonly PanelName[]): DockWeights {
  const next: DockWeights = {};
  for (const panel of panels) next[panel] = 1;
  return next;
}

export interface SplitPreview {
  /** The weights the release would commit. */
  weights: DockWeights;
  /** Where the boundary line has travelled from its rest position, in pixels. */
  offset: number;
  /** The two panels' sizes under `weights`, for the width readout. */
  fromSize: number;
  toSize: number;
}

/**
 * One splitter movement, previewed against the arrangement it started from.
 *
 * `delta` is the pointer's movement in pixels, positive towards `to` — the
 * panel after the splitter — so dragging the boundary towards `to` grows
 * `from` and shrinks `to`. Each frame is computed from the drag's starting
 * weights and total movement, never from the previous frame, so a drag that
 * hits the minimum and backs away moves again on the very next frame.
 *
 * Returns null only when the dock has no extent to divide; a movement the
 * clamps reduce to nothing still returns a preview, so the guide can rest at
 * the boundary it has reached.
 */
export function previewSplit(options: {
  panels: readonly PanelName[];
  weights: DockWeights;
  from: PanelName;
  to: PanelName;
  delta: number;
  extent: number;
}): SplitPreview | null {
  const { panels, weights, from, to, delta, extent } = options;
  if (extent <= 0 || !panels.includes(from) || !panels.includes(to) || from === to) return null;
  const total = totalWeight(panels, weights);
  if (total <= 0) return null;
  const perWeight = extent / total;
  if (perWeight <= 0) return null;
  const min = MIN_SLOT_PX / perWeight;
  const wa = weightOf(weights, from);
  const wb = weightOf(weights, to);
  const change = clamp(delta / perWeight, min - wa, wb - min);
  // The two panels in a pair never swap roles: a weight cannot go under the
  // minimum, and a clamp that would push one there is not applied at all.
  if (wa + change < min || wb - change < min) return null;
  const next: DockWeights = { ...weights, [from]: wa + change, [to]: wb - change };
  return {
    weights: next,
    offset: change * perWeight,
    fromSize: (wa + change) * perWeight,
    toSize: (wb - change) * perWeight,
  };
}

interface StoredSplits {
  [dock: string]: DockWeights;
}

function readStored(): StoredSplits {
  try {
    const raw = localStorage.getItem(DOCK_SPLITS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredSplits) : {};
  } catch {
    // A corrupt or blocked entry falls through to the even split.
    return {};
  }
}

/** The arrangement stored for this dock, filtered to the panels it holds. */
export function loadDockWeights(dock: PanelDock, panels: readonly PanelName[]): DockWeights {
  const stored = readStored()[dock];
  if (!stored || typeof stored !== "object") return {};
  const weights: DockWeights = {};
  for (const panel of panels) {
    const value = stored[panel];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      weights[panel] = value;
    }
  }
  return weights;
}

/** Writes one dock's arrangement; other docks keep theirs. */
export function saveDockWeights(
  dock: PanelDock,
  panels: readonly PanelName[],
  weights: DockWeights,
): void {
  try {
    const all = readStored();
    const next: DockWeights = {};
    for (const panel of panels) next[panel] = weightOf(weights, panel);
    all[dock] = next;
    localStorage.setItem(DOCK_SPLITS_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the arrangement still holds for this run.
  }
}
