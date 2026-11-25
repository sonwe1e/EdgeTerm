import type { Dispatch, SetStateAction } from "react";
import type { Translate } from "../../i18n";
import type { SavedCommand } from "../../types";
import { Icon } from "../icons";
import type { CommandContextMenu } from "./senderShared";

/** The same command actions as the context menu, available without right-click. */
export function SenderCommandOptions({
  command,
  t,
  hideCommandTooltip,
  setSelectedCommandId,
  setContextMenu,
  expanded = false,
}: {
  command: SavedCommand;
  t: Translate;
  hideCommandTooltip: () => void;
  setSelectedCommandId: Dispatch<SetStateAction<string | null>>;
  setContextMenu: Dispatch<SetStateAction<CommandContextMenu | null>>;
  /** Whether this row's context menu is the open one. */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="sender-command-options"
      aria-label={t("sender.optionsFor", { name: command.name })}
      title={t("sender.optionsFor", { name: command.name })}
      aria-haspopup="menu"
      aria-expanded={expanded}
      onClick={(event) => {
        hideCommandTooltip();
        setSelectedCommandId(command.id);
        const rect = event.currentTarget.getBoundingClientRect();
        setContextMenu({ commandId: command.id, x: rect.left, y: rect.bottom });
      }}
    >
      <Icon name="ellipsis" />
    </button>
  );
}
