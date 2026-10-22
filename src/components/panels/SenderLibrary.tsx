import type { Dispatch, SetStateAction } from "react";
import type { Translate } from "../../i18n";
import { senderColor, senderColorStyle } from "../../senderColors";
import { type LineEnding, type SavedCommand } from "../../types";
import { Icon } from "../icons";
import type { CommandContextMenu, Editing } from "./senderShared";

interface Props {
  pageCount: number;
  t: Translate;
  visibleCommands: SavedCommand[];
  currentPage: number;
  setPage: Dispatch<SetStateAction<number>>;
  pageCommands: SavedCommand[];
  emptyMessage: string;
  /** Opens the composer, for the empty state's call to action. */
  openComposer: () => void;
  selectedCommandId: string | null;
  editing: Editing | null;
  hideCommandTooltip: () => void;
  setSelectedCommandId: Dispatch<SetStateAction<string | null>>;
  setContextMenu: Dispatch<SetStateAction<CommandContextMenu | null>>;
  running: boolean;
  showCommandTooltip: (command: SavedCommand, element: HTMLElement) => void;
  sendCommand: (
    commandText: string,
    commandEnding: LineEnding,
    commandId?: string,
  ) => Promise<void>;
}

export function SenderLibrary({
  pageCount,
  t,
  visibleCommands,
  currentPage,
  setPage,
  pageCommands,
  emptyMessage,
  openComposer,
  selectedCommandId,
  editing,
  hideCommandTooltip,
  setSelectedCommandId,
  setContextMenu,
  running,
  showCommandTooltip,
  sendCommand,
}: Props) {
  return (
    <div className="sender-library">
      {pageCount > 1 && (
        <div className="sender-library-head">
          <span>{t("sender.savedCommandsCount", { count: visibleCommands.length })}</span>
          <div className="sender-pagination">
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              title={t("sender.previousPage")}
              aria-label={t("sender.previousPage")}
            >
              <Icon name="chevron-left" />
            </button>
            <span>
              {currentPage} / {pageCount}
            </span>
            <button
              type="button"
              disabled={currentPage === pageCount}
              onClick={() => setPage(currentPage + 1)}
              title={t("sender.nextPage")}
              aria-label={t("sender.nextPage")}
            >
              <Icon name="chevron-right" />
            </button>
          </div>
        </div>
      )}

      {pageCommands.length === 0 ? (
        /* An unused library gets a way in; a library filtered to nothing by
           the active session's scope only gets the explanation. */
        <div className="sender-library-empty">
          <p>{emptyMessage}</p>
          {visibleCommands.length === 0 && (
            <button
              type="button"
              className="sender-save-btn"
              onClick={openComposer}
            >
              {t("sender.createFirst")}
            </button>
          )}
        </div>
      ) : (
        <div className="sender-command-tags">
          {pageCommands.map((command) => (
            <div
              className={[
                "sender-command-tag",
                senderColor(command.color) ? "has-color" : "",
                selectedCommandId === command.id ? "is-selected" : "",
                editing?.command.id === command.id ? "is-editing" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={senderColorStyle(command.color)}
              key={command.id}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                hideCommandTooltip();
                setSelectedCommandId(command.id);
                setContextMenu({
                  commandId: command.id,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <button
                className="sender-command-load"
                type="button"
                data-own-tooltip
                aria-label={`Send ${command.name}: ${command.text}`}
                // Not `disabled`, which would swallow the right click.
                aria-disabled={running}
                onMouseEnter={(event) => showCommandTooltip(command, event.currentTarget)}
                onMouseLeave={hideCommandTooltip}
                // A press here must not move the focus: the point of a
                // saved command is to send it and keep typing in the
                // session, and the default focus change would leave the
                // keyboard on the button (or on the body, which is where
                // WebKit puts it for a button) until the terminal is
                // clicked again. Keyboard activation still focuses it.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (running) return;
                  setSelectedCommandId(command.id);
                  void sendCommand(command.text, command.ending);
                }}
              >
                {command.name}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
