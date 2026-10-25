import type { ReactNode } from "react";

import { exportAppData, importAppData, importSshConfig } from "../dataTransfer";
import { errorText } from "../errorInfo";
import { useFileTransfers } from "../fileTransfers";
import { commandHistory } from "../history";
import { LANGUAGES, LANGUAGE_LABELS, type Language } from "../i18n";
import { ask } from "../nativeDialog";
import { programClipboardLabels, type ProgramClipboardMode } from "../osc52";
import { HAS_TRAY, IS_MAC } from "../platform";
import { DOCK_NAMES, dockLabels, dockOf, panelLabels, PANEL_NAMES } from "../panelDock";
import { useStore } from "../store";
import type { GutterMode, RightClickAction } from "../terminal";
import type { CloseAction } from "../storeTypes";
import { THEME_MODES, themeLabels, type ThemeMode } from "../types";
import { useT } from "../useT";
import { Icon, type IconName } from "./icons";
import { ModalDialog } from "./ModalDialog";
import { SshReuseSetting } from "./SshReuseSetting";
import "../styles/settings.styles.css";

interface Props {
  onClose: () => void;
  /** Opens the display settings dialog (the app's own font and cursor sheet). */
  onDisplaySettings: () => void;
}

/** A group of rows: one card with a heading, the way the session form reads. */
function SettingsGroup({
  icon,
  title,
  hint,
  children,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group">
      <div className="settings-group-heading">
        <Icon name={icon} />
        <span>{title}</span>
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </section>
  );
}

/** One row: the setting named on the left, its control or action on the right. */
function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-main">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/** A row whose control is a single switch. */
function SettingsCheck({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-row settings-check-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings-row-main">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * A radio group drawn as a row of choices. Native radios keep the arrow-key
 * switching and the group name; the label draws the choice, the way the
 * tunnel form's direction segments do (forward.styles.css).
 */
function SettingsChoices<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="settings-choices">
      <legend className="sr-only">{name}</legend>
      {options.map((option) => (
        <label key={option.value} className="settings-choice">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The settings surface the 1.2.6 review asked for (PD-06): the preferences
 * that used to be scattered over seven places, gathered into groups. Every
 * preference here is store-driven, so a control in this dialog and the menu
 * entry it mirrors read the same state and stay in step; the two surfaces
 * that own richer controls of their own (the display settings dialog and the
 * status bar's transfer popover) are opened rather than copied.
 */
export function SettingsDialog({ onClose, onDisplaySettings }: Props) {
  const t = useT();
  const copyOnSelect = useStore((s) => s.copyOnSelect);
  const setCopyOnSelect = useStore((s) => s.setCopyOnSelect);
  const pasteWarning = useStore((s) => s.pasteWarning);
  const setPasteWarning = useStore((s) => s.setPasteWarning);
  const programClipboard = useStore((s) => s.programClipboard);
  const setProgramClipboard = useStore((s) => s.setProgramClipboard);
  const rightClickAction = useStore((s) => s.rightClickAction);
  const setRightClickAction = useStore((s) => s.setRightClickAction);
  const closeAction = useStore((s) => s.closeAction);
  const setCloseAction = useStore((s) => s.setCloseAction);
  const suggestionsEnabled = useStore((s) => s.suggestionsEnabled);
  const setSuggestionsEnabled = useStore((s) => s.setSuggestionsEnabled);
  const gutterMode = useStore((s) => s.gutterMode);
  const setGutterMode = useStore((s) => s.setGutterMode);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const language = useStore((s) => s.language);
  const setLanguage = useStore((s) => s.setLanguage);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const panelDocks = useStore((s) => s.panelDocks);
  const movePanel = useStore((s) => s.movePanel);
  const resetPanelLayout = useStore((s) => s.resetPanelLayout);
  const resetSettings = useStore((s) => s.resetSettings);
  const setStatus = useStore((s) => s.setStatus);

  const themes = themeLabels(t);
  const panelNames = panelLabels(t);
  const docks = dockLabels(t);
  const clipboards = programClipboardLabels(t);
  const gutterOptions: { value: GutterMode; label: string }[] = [
    { value: "both", label: t("menu.gutterBoth") },
    { value: "line", label: t("menu.gutterLine") },
    { value: "time", label: t("menu.gutterTime") },
    { value: "off", label: t("menu.gutterOff") },
  ];
  const clipboardOptions: { value: ProgramClipboardMode; label: string }[] = [
    { value: "ask", label: clipboards.ask },
    { value: "allow", label: clipboards.allow },
    { value: "deny", label: clipboards.deny },
  ];
  const closeOptions: { value: CloseAction; label: string }[] = [
    { value: "ask", label: t("menu.closeAsk") },
    { value: "tray", label: t("menu.closeTray") },
    { value: "exit", label: t("menu.closeExit") },
  ];
  const themeOptions: { value: ThemeMode; label: string }[] = THEME_MODES.map((mode) => ({
    value: mode,
    label: themes[mode],
  }));
  const languageOptions: { value: Language; label: string }[] = LANGUAGES.map((lang) => ({
    value: lang,
    label: LANGUAGE_LABELS[lang],
  }));
  // With Copy on Select the selection is copied already, so this mode only
  // pastes — the same label the Edit menu shows.
  const rightClickOptions: { value: RightClickAction; label: string }[] = [
    { value: "menu", label: t("menu.rightClickShowMenu") },
    {
      value: "copyPaste",
      label: copyOnSelect ? t("menu.rightClickPaste") : t("menu.rightClickCopyOrPaste"),
    },
  ];

  // The two surfaces that own richer controls are opened, not copied: this
  // dialog closes first so the one it hands over is not stacked under it.
  const openDisplaySettings = () => {
    onClose();
    onDisplaySettings();
  };
  const openTransferCenter = () => {
    onClose();
    // The popover's open state is the transfer store's own (see StatusBar),
    // so opening it is the action the status bar button performs.
    useFileTransfers.getState().setOpen(true);
  };
  // A data flow takes over with a native picker (and, for an SSH config
  // import, its own chooser dialog), so it starts from a closed settings
  // dialog and reports through the status bar.
  const runDataAction = (action: () => void) => {
    onClose();
    action();
  };

  const restoreDefaults = () => {
    void (async () => {
      const confirmed = await ask(t("confirm.restoreDefaults"), {
        title: t("confirm.restoreDefaultsTitle"),
        kind: "warning",
        okLabel: t("confirm.restore"),
        cancelLabel: t("common.cancel"),
      });
      if (!confirmed) return;
      resetSettings();
      setStatus(t("status.defaultSettingsRestored"));
    })();
  };

  const clearCommandHistory = () => {
    void (async () => {
      const confirmed = await ask(t("confirm.clearCommandHistory"), {
        title: t("confirm.clearCommandHistoryTitle"),
        kind: "warning",
        okLabel: t("confirm.clear"),
        cancelLabel: t("common.cancel"),
      });
      if (!confirmed) return;
      try {
        await commandHistory.clear();
        setStatus(t("status.commandHistoryCleared"));
      } catch (error) {
        setStatus(t("status.commandHistoryClearFailed", { error: errorText(error) }));
      }
    })();
  };

  return (
    <ModalDialog
      open
      labelledBy="settings-title"
      contentClassName="settings-dialog"
      onClose={onClose}
      dismissable={false}
    >
      <div className="dialog-header" id="settings-title">
        <span>{t("settings.title")}</span>
        <button
          className="panel-action"
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog-body settings-body">
        <p className="settings-intro">{t("settings.intro")}</p>

        <SettingsGroup icon="symbol-color" title={t("settings.groupAppearance")}>
          <SettingsRow label={t("menu.theme")}>
            <SettingsChoices
              name={t("menu.theme")}
              value={theme}
              options={themeOptions}
              onChange={setTheme}
            />
          </SettingsRow>
          <SettingsRow label={t("menu.displaySettings")} hint={t("settings.displaySettingsHint")}>
            <button type="button" className="btn settings-go" onClick={openDisplaySettings}>
              {t("settings.open")}
            </button>
          </SettingsRow>
          <SettingsRow label={t("menu.timestampLine")}>
            <SettingsChoices
              name={t("menu.timestampLine")}
              value={gutterMode}
              options={gutterOptions}
              onChange={setGutterMode}
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup icon="terminal" title={t("settings.groupTerminal")}>
          <SettingsCheck
            label={t("menu.copyOnSelect")}
            checked={copyOnSelect}
            onChange={setCopyOnSelect}
          />
          <SettingsCheck
            label={t("menu.warnMultiLinePaste")}
            checked={pasteWarning}
            onChange={setPasteWarning}
          />
          <SettingsRow label={t("menu.programsCanSetClipboard")}>
            <SettingsChoices
              name={t("menu.programsCanSetClipboard")}
              value={programClipboard}
              options={clipboardOptions}
              onChange={setProgramClipboard}
            />
          </SettingsRow>
          {/* Mouse copy / paste is a Windows / Linux choice; macOS terminals
              always open the menu, so the row is left out there, as the Edit
              menu leaves its submenu out. */}
          {!IS_MAC && (
            <SettingsRow label={t("menu.rightClick")}>
              <SettingsChoices
                name={t("menu.rightClick")}
                value={rightClickAction}
                options={rightClickOptions}
                onChange={setRightClickAction}
              />
            </SettingsRow>
          )}
          {HAS_TRAY && (
            <SettingsRow label={t("menu.closeWindow")}>
              <SettingsChoices
                name={t("menu.closeWindow")}
                value={closeAction}
                options={closeOptions}
                onChange={setCloseAction}
              />
            </SettingsRow>
          )}
          <SettingsCheck
            label={t("menu.commandSuggestions")}
            checked={suggestionsEnabled}
            onChange={setSuggestionsEnabled}
          />
        </SettingsGroup>

        <SettingsGroup icon="plug" title={t("settings.groupConnection")}>
          {/* The session panel's own control, inlined: it is store-driven, so
              the two surfaces share one state. */}
          <SshReuseSetting />
        </SettingsGroup>

        <SettingsGroup
          icon="arrow-swap"
          title={t("settings.groupTransfer")}
          hint={t("settings.transferHint")}
        >
          <SettingsRow label={t("settings.transferSettings")} hint={t("settings.transferLocation")}>
            <button type="button" className="btn settings-go" onClick={openTransferCenter}>
              {t("settings.open")}
            </button>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup icon="multiple-windows" title={t("settings.groupPanels")}>
          <SettingsRow label={t("settings.panelsVisible")}>
            <span className="settings-checks">
              {PANEL_NAMES.map((panel) => (
                <label key={panel} className="settings-choice">
                  <input
                    type="checkbox"
                    checked={panels[panel]}
                    onChange={() => togglePanel(panel)}
                  />
                  <span>{panelNames[panel]}</span>
                </label>
              ))}
            </span>
          </SettingsRow>
          {PANEL_NAMES.map((panel) => (
            <SettingsRow key={panel} label={t("settings.panelDock", { panel: panelNames[panel] })}>
              <SettingsChoices
                name={panelNames[panel]}
                value={dockOf(panelDocks, panel)}
                options={DOCK_NAMES.map((dock) => ({
                  value: dock,
                  label: docks[dock],
                }))}
                onChange={(dock) => movePanel(panel, dock)}
              />
            </SettingsRow>
          ))}
          <SettingsRow label={t("menu.resetPanelLayout")}>
            <button type="button" className="btn settings-go" onClick={() => resetPanelLayout()}>
              {t("settings.reset")}
            </button>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup icon="export" title={t("settings.groupData")}>
          <SettingsRow label={t("menu.exportData")}>
            <button
              type="button"
              className="btn settings-go"
              onClick={() => runDataAction(() => void exportAppData())}
            >
              {t("settings.open")}
            </button>
          </SettingsRow>
          <SettingsRow label={t("menu.importData")}>
            <button
              type="button"
              className="btn settings-go"
              onClick={() => runDataAction(() => void importAppData())}
            >
              {t("settings.open")}
            </button>
          </SettingsRow>
          <SettingsRow label={t("menu.importOpenSshConfig")}>
            <button
              type="button"
              className="btn settings-go"
              onClick={() => runDataAction(() => void importSshConfig())}
            >
              {t("settings.open")}
            </button>
          </SettingsRow>
          <SettingsRow label={t("menu.language")}>
            <SettingsChoices
              name={t("menu.language")}
              value={language}
              options={languageOptions}
              onChange={setLanguage}
            />
          </SettingsRow>
          <SettingsRow label={t("menu.clearCommandHistory")}>
            <button type="button" className="btn settings-go" onClick={clearCommandHistory}>
              {t("confirm.clear")}
            </button>
          </SettingsRow>
          <SettingsRow label={t("menu.restoreDefaultSettings")} hint={t("settings.restoreNote")}>
            <button type="button" className="btn is-danger settings-go" onClick={restoreDefaults}>
              {t("confirm.restore")}
            </button>
          </SettingsRow>
        </SettingsGroup>
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </ModalDialog>
  );
}
