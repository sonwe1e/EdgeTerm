import { forgetLatency } from "./inputLatency";
import type { TerminalController } from "./terminal";

/**
 * Terminal instances outlive the React components that display them, so that
 * switching tabs never destroys scrollback. React only ever borrows the DOM
 * node; this registry owns the lifetime.
 */
const registry = new Map<string, TerminalController>();
const listeners = new Set<() => void>();

export function subscribeControllers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyControllersChanged() {
  for (const listener of listeners) listener();
}

// Keep the renderer preference outside terminal.ts so App does not eagerly
// import xterm and the terminal controller just to update this setting.
let webglEnabled = true;
export const isWebglEnabled = () => webglEnabled;
export function setWebglEnabled(enabled: boolean) {
  webglEnabled = enabled;
  for (const controller of registry.values()) controller.refreshWebgl();
}

export function setController(id: string, controller: TerminalController) {
  if (registry.get(id) === controller) return;
  registry.set(id, controller);
  notifyControllersChanged();
}

export function getController(id: string): TerminalController | undefined {
  return registry.get(id);
}

export function disposeController(id: string) {
  registry.get(id)?.dispose();
  // A closed session's samples must not outlive it: the chip would otherwise
  // keep showing a number for a tab that no longer exists.
  forgetLatency(id);
  if (registry.delete(id)) notifyControllersChanged();
}

export function allControllers(): TerminalController[] {
  return [...registry.values()];
}
