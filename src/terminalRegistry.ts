import type { TerminalController } from "./terminal";

/**
 * Terminal instances outlive the React components that display them, so that
 * switching tabs never destroys scrollback. React only ever borrows the DOM
 * node; this registry owns the lifetime.
 */
const registry = new Map<string, TerminalController>();

// Keep the renderer preference outside terminal.ts so App does not eagerly
// import xterm and the terminal controller just to update this setting.
let webglEnabled = true;
export const isWebglEnabled = () => webglEnabled;
export function setWebglEnabled(enabled: boolean) {
  webglEnabled = enabled;
  for (const controller of registry.values()) controller.refreshWebgl();
}

export function setController(id: string, controller: TerminalController) {
  registry.set(id, controller);
}

export function getController(id: string): TerminalController | undefined {
  return registry.get(id);
}

export function disposeController(id: string) {
  registry.get(id)?.dispose();
  registry.delete(id);
}

export function allControllers(): TerminalController[] {
  return [...registry.values()];
}
