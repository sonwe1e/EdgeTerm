import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Translate } from "../../i18n";
import type { ScheduleState } from "../../senderSchedule";
import { stopSchedule } from "../../senderSchedule";
import { firstLine } from "../../senderUnits";
import type { Tab } from "../../store";
import { type LineEnding, type SavedCommand } from "../../types";
import { Icon } from "../icons";
import type { CommandContextMenu, Editing } from "./senderShared";
import { Target } from "./senderShared";

interface Props {
  t: Translate;
  visibleCommands: Required<SavedCommand>[];
  emptyMessage: string;
  running: boolean;
  /** The saved command currently being sent, so its tag can be marked. */
  sendingId: string | null;
  showCommandTooltip: (command: SavedCommand, element: HTMLElement) => void;
  hideCommandTooltip: () => void;
  setSelectedCommandId: Dispatch<SetStateAction<string | null>>;
  sendCommand: (
    commandText: string,
    commandEnding: LineEnding,
    commandId?: string,
  ) => Promise<void>;
  setContextMenu: Dispatch<SetStateAction<CommandContextMenu | null>>;
  moreButtonRef: RefObject<HTMLButtonElement | null>;
  moreAnchor: { left: number; bottom: number } | null;
  closeMore: () => void;
  setMoreQuery: Dispatch<SetStateAction<string>>;
  setMoreAnchor: Dispatch<SetStateAction<{ left: number; bottom: number } | null>>;
  stopSending: () => void | undefined;
  schedule: ScheduleState | null;
  target: Target;
  setTarget: Dispatch<SetStateAction<Target>>;
  tabs: Tab[];
  openComposer: () => void;
  editing: Editing | null;
}

export function SenderQuickbar({
  t,
  visibleCommands,
  emptyMessage,
  running,
  sendingId,
  showCommandTooltip,
  hideCommandTooltip,
  setSelectedCommandId,
  sendCommand,
  setContextMenu,
  moreButtonRef,
  moreAnchor,
  closeMore,
  setMoreQuery,
  setMoreAnchor,
  stopSending,
  schedule,
  target,
  setTarget,
  tabs,
  openComposer,
  editing,
}: Props) {
  return (
    <div className="panel-header sender-quickbar">
      <div className="panel-title is-sender sender-quick-title">
        <Icon name="send" />
        {t("panel.sender")}
      </div>
      <div
        className="sender-quick-tags"
        aria-label={t("sender.savedCommands")}
        onWheel={(event) => {
          if (event.currentTarget.scrollWidth > event.currentTarget.clientWidth) {
            event.currentTarget.scrollLeft += event.deltaY;
          }
        }}
      >
        {visibleCommands.length === 0 ? (
          <span className="sender-quick-empty">{emptyMessage}</span>
        ) : (
          visibleCommands.map((command) => (
            <div
              className={`sender-command-tag sender-quick-tag${
                sendingId === command.id ? " is-sending" : ""
              }`}
              key={command.id}
            >
              <button
                type="button"
                className="sender-command-load"
                data-own-tooltip
                aria-label={t("sender.sendAria", { name: command.name, text: command.text })}
                disabled={running}
                onMouseEnter={(event) => showCommandTooltip(command, event.currentTarget)}
                onMouseLeave={hideCommandTooltip}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSelectedCommandId(command.id);
                  void sendCommand(command.text, command.ending, command.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  hideCommandTooltip();
                  setContextMenu({ commandId: command.id, x: event.clientX, y: event.clientY });
                }}
              >
                <Icon name="run-compact" />
                <span>{command.name}</span>
              </button>
              <button
                type="button"
                className="sender-quick-options"
                aria-label={t("sender.optionsFor", { name: command.name })}
                title={t("sender.optionsFor", { name: command.name })}
                onClick={(event) => {
                  hideCommandTooltip();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setContextMenu({ commandId: command.id, x: rect.right, y: rect.top });
                }}
              >
                <Icon name="ellipsis" />
              </button>
            </div>
          ))
        )}
      </div>
      <button
        ref={moreButtonRef}
        type="button"
        className="sender-quick-button"
        aria-expanded={moreAnchor !== null}
        onClick={() => {
          if (moreAnchor) return closeMore();
          hideCommandTooltip();
          const rect = moreButtonRef.current?.getBoundingClientRect();
          if (!rect) return;
          setMoreQuery("");
          setMoreAnchor({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)),
            bottom: window.innerHeight - rect.top + 4,
          });
        }}
      >
        {t("sender.more")} <span className="sender-quick-count">{visibleCommands.length}</span>
        <Icon name="chevron-down" />
      </button>
      {running && (
        <button
          type="button"
          className="sender-quick-button is-stop"
          title={t("sender.stopAfterLine")}
          onClick={stopSending}
        >
          <Icon name="debug-stop" />
          {t("sender.stopSending")}
        </button>
      )}
      {schedule && (
        <button
          type="button"
          className="sender-quick-button is-running"
          title={t("sender.repeating", { text: firstLine(schedule.spec.text) })}
          onClick={stopSchedule}
        >
          <Icon name="watch" />
          {t("sender.stopRepeat")}
        </button>
      )}
      <label className="sender-quick-target select-wrap">
        <select
          className="select"
          value={target}
          aria-label={t("sender.targets")}
          onChange={(event) => setTarget(event.target.value as Target)}
        >
          <option value="current">{t("sender.currentSession")}</option>
          <option value="all">{t("sender.allSessions", { count: tabs.length })}</option>
        </select>
        <Icon name="chevron-down" className="select-chevron" />
      </label>
      <button type="button" className="sender-quick-button is-primary" onClick={openComposer}>
        <Icon name="add" />
        {editing ? t("sender.continueEditing") : t("sender.new")}
      </button>
      <button
        type="button"
        className="sender-quick-button is-icon"
        title={t("sender.expand")}
        aria-label={t("sender.expand")}
        onClick={openComposer}
      >
        <Icon name="arrow-up" />
      </button>
    </div>
  );
}
