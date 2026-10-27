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
}: {
  command: SavedCommand;
  t: Translate;
  hideCommandTooltip: () => void;
  setSelectedCommandId: Dispatch<SetStateAction<string | null>>;
  setContextMenu: Dispatch<SetStateAction<CommandContextMenu | null>>;
}) {
  return (
    <button
      type="button"
      className="sender-command-options"
      aria-label={t("sender.optionsFor", { name: command.name })}
      title={t("sender.optionsFor", { name: command.name })}
      aria-haspopup="menu"
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
