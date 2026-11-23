import { t, type MessageKey } from "./i18n";
import { useStore } from "./store";
import { getController } from "./terminalRegistry";

/**
 * The three walks through a tab buffer — commands, the commands the shell
 * reported failed, and the gutter watch marks. They differ only in which list
 * the controller steps through and what the bar says when that list is empty,
 * so they share one landing, one message rule and one implementation: the
 * keyboard, the palette and the menu all go through here.
 */

export type JumpFamily = "command" | "failed" | "watch";

const EMPTY_MESSAGES: Record<JumpFamily, MessageKey> = {
  command: "status.noCommandToJump",
  failed: "status.noFailedCommand",
  watch: "status.noWatchMark",
};

/** True when the walk landed somewhere; false reports the reason in the bar. */
export function jumpInActiveTab(family: JumpFamily, direction: -1 | 1): boolean {
  const state = useStore.getState();
  const controller = state.activeId ? getController(state.activeId) : null;
  const landed =
    family === "command"
      ? controller?.jumpToCommand(direction)
      : family === "failed"
        ? controller?.jumpToFailedCommand(direction)
        : controller?.jumpToWatchMark(direction);
  if (!landed) state.setStatus(t(EMPTY_MESSAGES[family]));
  return landed === true;
}
