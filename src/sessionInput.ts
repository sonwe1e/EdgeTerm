import * as api from "./api";
import { broadcastTargets, isTerminalResponse } from "./broadcast";
import { latencyMeter } from "./inputLatency";
import { bufferPendingInput } from "./pendingInput";
import { useStore } from "./store";

/**
 * Every byte the reader types in a terminal leaves through here. It used to be
 * the controller's callback body; it is its own module so two behaviours that
 * are easy to get wrong can be tested without a terminal: input typed during
 * the handshake is held (never dropped), and synchronized input writes the
 * same bytes to every other connected shell — but not while the source is
 * still connecting, where the bytes have not reached a shell yet either.
 */
export function sendSessionInput(id: string, data: string): void {
  const store = useStore.getState();
  const tab = store.tabs.find((item) => item.info.id === id);
  if (tab?.state === "connecting") {
    bufferPendingInput(id, data);
    return;
  }
  void api.writeSession(id, data).catch(() => undefined);
  // The keystroke is on its way; the answer may arrive on a later turn.
  latencyMeter(id).markSent(performance.now());
  // A protocol reply is this pane's answer to this pane's program; every
  // other shell would be answering a question it never asked.
  if (!store.broadcastInput || isTerminalResponse(data)) return;
  for (const target of broadcastTargets(
    store.tabs,
    id,
    store.broadcastExcluded,
    store.broadcastExcludedGroups,
  )) {
    void api.writeSession(target, data).catch(() => undefined);
  }
}
