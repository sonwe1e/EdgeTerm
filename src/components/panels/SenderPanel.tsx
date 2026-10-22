import { useCallback, useEffect, useRef, useState } from "react";
import { SenderLibrary } from "./SenderLibrary";
import { SenderQuickbar } from "./SenderQuickbar";
import { SenderRepeat } from "./SenderRepeat";
import {
  CommandTooltip,
  lineEndings,
  MAX_SAVED_COMMANDS,
  SenderPanelProps,
  Target,
} from "./senderShared";
import { useSenderLibrary } from "./useSenderLibrary";
import { useSenderSend } from "./useSenderSend";

import { ask } from "../../nativeDialog";
import {
  SENDER_COLORS,
  senderColor,
  senderColorLabelKey,
  senderColorStyle,
  senderColorValue,
} from "../../senderColors";
import { describeScope, sameScope, scopeForLevel } from "../../senderScope";
import { endingLabel } from "../../senderUnits";
import { useStore } from "../../store";
import { getController } from "../../terminalRegistry";
import { type LineEnding, type SavedCommand } from "../../types";
import { useT } from "../../useT";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { Icon } from "../icons";

export function SenderPanel({ compact, canCompact, onExpandedChange }: SenderPanelProps) {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const t = useT();

  const [text, setText] = useState("");
  const [tagName, setTagName] = useState("");
  const [ending, setEnding] = useState<LineEnding>("lf");
  const [commandTooltip, setCommandTooltip] = useState<CommandTooltip | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [moreQuery, setMoreQuery] = useState("");
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commandRef = useRef<HTMLTextAreaElement>(null);

  // The command box grows with its lines, up to the stylesheet's max-height.
  useEffect(() => {
    const box = commandRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [text, compact]);

  const closeMore = useCallback(() => setMoreAnchor(null), []);

  useEffect(() => {
    if (!compact) closeMore();
  }, [compact, closeMore]);

  useEffect(
    () => () => {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!moreAnchor) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!moreMenuRef.current?.contains(target) && !moreButtonRef.current?.contains(target)) {
        setMoreAnchor(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMoreAnchor(null);
        moreButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", closeMore);
    return () => {
      document.removeEventListener("mousedown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", closeMore);
    };
  }, [moreAnchor, closeMore]);

  const openComposer = () => {
    closeMore();
    onExpandedChange(true);
    requestAnimationFrame(() => commandRef.current?.focus());
  };

  const activeTab = tabs.find((tab) => tab.info.id === activeId);
  const {
    setStatus,
    visibleCommands,
    labelOf,
    emptyMessage,
    setSelectedCommandId,
    setContextMenu,
    editing,
    closeSavePicker,
    cancelEdit,
    openSavePicker,
    saveButtonRef,
    libraryBusy,
    savePicker,
    commandsLoading,
    savedCommands,
    chain,
    saveLevel,
    pickSaveScope,
    pageCount,
    currentPage,
    setPage,
    pageCommands,
    selectedCommandId,
    contextMenu,
    beginEdit,
    updateSaved,
    removeCommand,
    closeContextMenu,
  } = useSenderLibrary({
    t,
    activeTab,
    text,
    tagName,
    ending,
    setTagName,
    setEnding,
    compact,
    onExpandedChange,
    closeMore,
    setText,
  });

  const {
    running,
    sendingId,
    sentLines,
    totalLines,
    sendCommand,
    stopSending,
    schedule,
    target,
    setTarget,
    repeatOpen,
    setRepeatOpen,
    now,
    repeat,
    setRepeat,
    beginRepeat,
  } = useSenderSend({ tabs, activeId, setStatus, t, activeTab });
  const moreMatches = moreAnchor
    ? visibleCommands.filter((command) =>
        `${command.name}\n${command.text}\n${labelOf(command.scope)}`
          .toLocaleLowerCase()
          .includes(moreQuery.toLocaleLowerCase().trim()),
      )
    : [];

  const hideCommandTooltip = () => {
    if (tooltipTimer.current) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
    setCommandTooltip(null);
  };

  const showCommandTooltip = (command: SavedCommand, element: HTMLElement) => {
    hideCommandTooltip();
    const rect = element.getBoundingClientRect();
    tooltipTimer.current = setTimeout(() => {
      setCommandTooltip({
        // The line ending is in the Edit view; the tooltip answers "what
        // does this send, and where is it listed".
        text: command.text,
        details: labelOf(command.scope),
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 428)),
        y: rect.top - 8,
      });
      tooltipTimer.current = null;
    }, 200);
  };

  return (
    <>
      {compact ? (
        <SenderQuickbar
          t={t}
          visibleCommands={visibleCommands}
          emptyMessage={emptyMessage}
          running={running}
          sendingId={sendingId}
          showCommandTooltip={showCommandTooltip}
          hideCommandTooltip={hideCommandTooltip}
          setSelectedCommandId={setSelectedCommandId}
          sendCommand={sendCommand}
          setContextMenu={setContextMenu}
          moreButtonRef={moreButtonRef}
          moreAnchor={moreAnchor}
          closeMore={closeMore}
          setMoreQuery={setMoreQuery}
          setMoreAnchor={setMoreAnchor}
          stopSending={stopSending}
          schedule={schedule}
          target={target}
          setTarget={setTarget}
          tabs={tabs}
          openComposer={openComposer}
          editing={editing}
        />
      ) : (
        <>
          <div className="panel-header sender-header">
            <div className="panel-title is-sender">
              <Icon name="send" />
              {t("panel.sender")}
            </div>
            <div className="sender-options">
              <label className="sender-field">
                <span>{t("sender.ending")}</span>
                <span className="select-wrap">
                  <select
                    className="select"
                    value={ending}
                    onChange={(event) => setEnding(event.target.value as LineEnding)}
                  >
                    <option value="none">{t("sender.endingNone")}</option>
                    <option value="lf">LF (\n)</option>
                    <option value="crlf">CRLF (\r\n)</option>
                  </select>
                  <Icon name="chevron-down" className="select-chevron" />
                </span>
              </label>

              <label className="sender-field">
                <span>{t("sender.targetsLabel")}</span>
                <span className="select-wrap">
                  <select
                    className="select"
                    value={target}
                    onChange={(event) => setTarget(event.target.value as Target)}
                  >
                    <option value="current">{t("sender.currentSession")}</option>
                    <option value="all">{t("sender.allSessions", { count: tabs.length })}</option>
                  </select>
                  <Icon name="chevron-down" className="select-chevron" />
                </span>
              </label>
            </div>
            {canCompact && (
              <button
                type="button"
                className="sender-collapse"
                title={t("sender.showSavedInRow")}
                aria-label={t("sender.collapse")}
                onClick={() => {
                  closeSavePicker();
                  onExpandedChange(false);
                }}
              >
                <Icon name="arrow-down" />
              </button>
            )}
          </div>

          <div className="sender-compose">
            <div className="sender-command">
              <textarea
                ref={commandRef}
                className={`sender-command-input${editing ? " is-editing" : ""}`}
                rows={1}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={text}
                placeholder={t("sender.typeCommand", { ending: endingLabel(ending) })}
                onChange={(event) => {
                  if (!editing) setSelectedCommandId(null);
                  setText(event.target.value);
                }}
                onKeyDown={(event) => {
                  // Enter runs, Shift+Enter adds a line. An Enter that ends an
                  // IME composition belongs to the input method.
                  if (event.key === "Enter" && !event.shiftKey) {
                    if (event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    void sendCommand(text, ending);
                  } else if (event.key === "Escape" && editing) {
                    event.preventDefault();
                    cancelEdit();
                  }
                }}
              />
              {text.length > 0 && (
                <button
                  type="button"
                  className="sender-clear"
                  onClick={() => setText("")}
                  title={t("sender.clear")}
                  aria-label={t("sender.clearCommand")}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
            {/* Which line of a multi-line script is on its way out. A
                single-line command has nothing to count, so the readout only
                appears once there is more than one line to send. */}
            {running && totalLines > 1 && (
              <span className="sender-progress" role="status">
                {t("sender.sendingLine", { current: sentLines, total: totalLines })}
              </span>
            )}
            {running ? (
              <button
                type="button"
                className="sender-send is-stop"
                onClick={stopSending}
                title={t("sender.stopAfterLine")}
                aria-label={t("sender.stopSending")}
              >
                <Icon name="debug-stop" />
              </button>
            ) : (
              <button
                type="button"
                className="sender-send"
                onClick={() => void sendCommand(text, ending)}
                title={t("sender.runCommandEnter")}
                aria-label={t("sender.runCommand")}
              >
                <Icon name="run-compact" />
              </button>
            )}
            <button
              type="button"
              className={[
                "sender-repeat-toggle",
                schedule ? "is-running" : repeatOpen ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setRepeatOpen((open) => !open)}
              title={schedule ? t("sender.repeatingTimer") : t("sender.repeatTimer")}
              aria-label={t("sender.repeatTimer")}
              aria-pressed={repeatOpen || schedule !== null}
            >
              <Icon name="watch" />
            </button>
            <div className="sender-compose-divider" aria-hidden="true" />
            <input
              className="sender-label-input"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={80}
              value={tagName}
              placeholder={t("sender.tagName")}
              aria-label={t("sender.savedCommandTagName")}
              onChange={(event) => setTagName(event.target.value.replace(/[\r\n]+/g, ""))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  openSavePicker();
                } else if (event.key === "Escape" && editing) {
                  event.preventDefault();
                  cancelEdit();
                }
              }}
            />
            {editing ? (
              <>
                <button
                  className="sender-save-btn"
                  type="button"
                  ref={saveButtonRef}
                  disabled={libraryBusy || text.length === 0}
                  title={t("sender.updateTitle", { name: editing.command.name })}
                  aria-haspopup="menu"
                  aria-expanded={savePicker !== null}
                  onClick={openSavePicker}
                >
                  {t("sender.update")}
                </button>
                <button
                  className="sender-save-btn is-secondary"
                  type="button"
                  disabled={libraryBusy}
                  onClick={cancelEdit}
                >
                  {t("common.cancel")}
                </button>
              </>
            ) : (
              <button
                className="sender-save-btn"
                type="button"
                ref={saveButtonRef}
                disabled={
                  commandsLoading ||
                  libraryBusy ||
                  text.length === 0 ||
                  savedCommands.length >= MAX_SAVED_COMMANDS
                }
                title={t("sender.saveTitle")}
                aria-haspopup="menu"
                aria-expanded={savePicker !== null}
                onClick={openSavePicker}
              >
                {t("sender.save")}
              </button>
            )}
          </div>

          {(repeatOpen || schedule) && (
            <SenderRepeat
              schedule={schedule}
              t={t}
              now={now}
              repeat={repeat}
              setRepeat={setRepeat}
              text={text}
              beginRepeat={beginRepeat}
              ending={ending}
            />
          )}

          {savePicker &&
            (() => {
              // Broadest first, like every scope list. The check marks the current
              // scope of the tag being edited, or the level picked last time.
              const preselected = editing ? editing.command.scope : scopeForLevel(chain, saveLevel);
              const items: MenuItem[] = [
                { heading: editing ? t("sender.updateAndList") : t("sender.saveAndList") },
                ...chain.map((scope) => ({
                  label: `${labelOf(scope)}${describeScope(scope, t)}`,
                  checked: sameScope(scope, preselected),
                  mark: "radio" as const,
                  action: () => pickSaveScope(scope),
                })),
              ];
              return (
                <ContextMenu
                  x={savePicker.x}
                  y={savePicker.y}
                  align="right"
                  items={items}
                  onClose={closeSavePicker}
                />
              );
            })()}

          <SenderLibrary
            pageCount={pageCount}
            t={t}
            visibleCommands={visibleCommands}
            currentPage={currentPage}
            setPage={setPage}
            pageCommands={pageCommands}
            emptyMessage={emptyMessage}
            openComposer={openComposer}
            selectedCommandId={selectedCommandId}
            editing={editing}
            hideCommandTooltip={hideCommandTooltip}
            setSelectedCommandId={setSelectedCommandId}
            setContextMenu={setContextMenu}
            running={running}
            showCommandTooltip={showCommandTooltip}
            sendCommand={sendCommand}
          />
        </>
      )}

      {moreAnchor && (
        <div
          ref={moreMenuRef}
          className="sender-more-menu"
          role="dialog"
          aria-label={t("sender.findSaved")}
          style={{ left: moreAnchor.left, bottom: moreAnchor.bottom }}
        >
          <div className="sender-more-search">
            <Icon name="search" />
            <input
              autoFocus
              type="search"
              value={moreQuery}
              placeholder={t("sender.findSavedCommand")}
              aria-label={t("sender.findSavedCommand")}
              onChange={(event) => setMoreQuery(event.target.value)}
            />
          </div>
          <div className="sender-more-list">
            {moreMatches.slice(0, 100).map((command) => (
              <button
                type="button"
                key={command.id}
                className="sender-more-item"
                style={senderColorStyle(command.color)}
                disabled={running}
                onClick={() => {
                  closeMore();
                  setSelectedCommandId(command.id);
                  void sendCommand(command.text, command.ending);
                  if (activeId) getController(activeId)?.focus();
                }}
              >
                <Icon name="run-compact" />
                <span className="sender-more-name">{command.name}</span>
                <span className="sender-more-scope">{labelOf(command.scope)}</span>
              </button>
            ))}
            {moreMatches.length === 0 && (
              <span className="sender-more-empty">{t("sender.noMatching")}</span>
            )}
          </div>
          {moreMatches.length > 100 && (
            <div className="sender-more-foot">
              {t("sender.showingOf", { count: moreMatches.length })}
            </div>
          )}
        </div>
      )}

      {contextMenu &&
        (() => {
          const command = savedCommands.find((candidate) => candidate.id === contextMenu.commandId);
          if (!command) return null;
          const items: MenuItem[] = [
            {
              label: t("panel.edit"),
              icon: "edit",
              disabled: libraryBusy,
              action: () => beginEdit(command),
            },
            {
              label: t("sender.sendRepeatedly"),
              icon: "watch",
              action: () => beginRepeat(command.text, command.ending),
            },
            {
              label: t("sender.color"),
              icon: "symbol-color",
              children: [
                {
                  label: t("sender.colorNone"),
                  checked: senderColor(command.color) === null,
                  mark: "radio" as const,
                  swatch: null,
                  disabled: libraryBusy,
                  action: () => void updateSaved(command, { color: null }),
                },
                ...SENDER_COLORS.map((value) => ({
                  label: t(senderColorLabelKey(value)),
                  checked: command.color === value,
                  mark: "radio" as const,
                  swatch: senderColorValue(value),
                  disabled: libraryBusy,
                  action: () => void updateSaved(command, { color: value }),
                })),
              ],
            },
            {
              label: t("sender.lineEnding"),
              icon: "newline",
              children: lineEndings(t).map(([value, label]) => ({
                label,
                checked: command.ending === value,
                mark: "radio" as const,
                disabled: libraryBusy,
                action: () => void updateSaved(command, { ending: value }),
              })),
            },
            {
              label: t("sender.scope"),
              icon: "target",
              children: chain.map((scope) => ({
                label: labelOf(scope),
                checked: sameScope(command.scope, scope),
                mark: "radio" as const,
                disabled: libraryBusy,
                action: () => void updateSaved(command, { scope }),
              })),
            },
            "separator",
            {
              label: t("common.delete"),
              icon: "trash",
              danger: true,
              disabled: libraryBusy,
              action: () =>
                void ask(
                  t("sender.deleteConfirm", { name: command.name }),
                  {
                    title: t("sender.deleteConfirmTitle"),
                    kind: "warning",
                    okLabel: t("common.delete"),
                    cancelLabel: t("common.cancel"),
                  },
                ).then((confirmed) => {
                  if (confirmed) void removeCommand(command.id);
                }),
            },
          ];
          return (
            <ContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              items={items}
              onClose={closeContextMenu}
            />
          );
        })()}

      {commandTooltip && (
        <div
          className="sender-command-tooltip"
          role="tooltip"
          style={{ left: commandTooltip.x, top: commandTooltip.y }}
        >
          <div>{commandTooltip.text}</div>
          <span>{commandTooltip.details}</span>
        </div>
      )}
    </>
  );
}
