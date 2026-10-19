import { useEffect, useMemo, useState } from "react";

import { listSystemFonts, type FontFamily } from "../api";
import {
  fontChoices,
  fontStack,
  installedFonts,
  symbolFallbacks,
} from "../fonts";
import {
  BUFFER_FONT_SIZE,
  PANEL_FONT_SIZE,
  scrollbackMegabytes,
  TERMINAL_SCROLLBACK,
  useStore,
} from "../store";
import type { CursorStyle } from "../terminal";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

/** Everything the dialog hands back when Apply is pressed. */
export interface DisplaySettings {
  panelFontSize: number;
  bufferFontSize: number;
  panelFontFamily: string;
  bufferFontFamily: string;
  terminalScrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  gpuRenderer: boolean;
}

interface Props extends DisplaySettings {
  onApply: (settings: DisplaySettings) => void;
  onClose: () => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function FontSizeDialog({
  panelFontSize,
  bufferFontSize,
  panelFontFamily,
  bufferFontFamily,
  terminalScrollback,
  cursorStyle,
  cursorBlink,
  gpuRenderer,
  onApply,
  onClose,
}: Props) {
  const [panelSize, setPanelSize] = useState(panelFontSize);
  const [bufferSize, setBufferSize] = useState(bufferFontSize);
  const [panelFamily, setPanelFamily] = useState(panelFontFamily);
  const [bufferFamily, setBufferFamily] = useState(bufferFontFamily);
  const [scrollback, setScrollback] = useState(terminalScrollback);
  const [cursor, setCursor] = useState<CursorStyle>(cursorStyle);
  const [blink, setBlink] = useState(cursorBlink);
  const [gpu, setGpu] = useState(gpuRenderer);
  const t = useT();

  // Probing the machine for installed families measures text on a canvas, so
  // it happens once when the dialog opens rather than on every keystroke.
  // The saved family is kept in its list even where it is not installed, so a
  // setting brought in from another machine stays visible.
  const [probedUi] = useState(() => installedFonts("ui", panelFontFamily));
  const [probedMono] = useState(() =>
    installedFonts("mono", bufferFontFamily),
  );
  // The backend reads the font directories meanwhile: every family it finds
  // joins the suggestions when it answers, and the probe stands on its own if
  // it never does (see fontChoices). The terminal's icon fallback takes the
  // fresh list too, so a Nerd Font installed since start-up is picked up
  // without a restart.
  const [systemFonts, setSystemFonts] = useState<FontFamily[]>([]);
  useEffect(() => {
    let live = true;
    listSystemFonts()
      .then((fonts) => {
        useStore.getState().setSymbolFontFamilies(symbolFallbacks(fonts));
        if (live) setSystemFonts(fonts);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const uiFonts = useMemo(
    () => fontChoices("ui", probedUi, systemFonts),
    [probedUi, systemFonts],
  );
  const monoFonts = useMemo(
    () => fontChoices("mono", probedMono, systemFonts),
    [probedMono, systemFonts],
  );

  const updateNumber = (
    value: number,
    setValue: (value: number) => void,
    min: number,
    max: number,
  ) => {
    // A Backspace-cleared number field reports NaN via valueAsNumber while the
    // raw string is "". Ignoring it leaves the old value on screen, so the
    // field looks dead. Fall back to min so the clear is visible and the user
    // can keep typing a replacement.
    if (Number.isNaN(value)) {
      setValue(min);
      return;
    }
    if (Number.isFinite(value)) setValue(clamp(Math.round(value), min, max));
  };

  const updateNumberInput = (
    raw: string,
    valueAsNumber: number,
    setValue: (value: number) => void,
    min: number,
    max: number,
  ) => {
    if (raw.trim() === "") {
      setValue(min);
      return;
    }
    updateNumber(valueAsNumber, setValue, min, max);
  };

  return (
    <ModalDialog
      open
      labelledBy="display-settings-title"
      contentClassName="font-size-dialog"
      onClose={onClose}
      dismissable={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onApply({
            panelFontSize: panelSize,
            bufferFontSize: bufferSize,
            panelFontFamily: panelFamily.trim(),
            bufferFontFamily: bufferFamily.trim(),
            terminalScrollback: scrollback,
            cursorStyle: cursor,
            cursorBlink: blink,
            gpuRenderer: gpu,
          });
        }}
      >
        <div className="dialog-header" id="display-settings-title">{t("fontDialog.title")}</div>
        <div className="dialog-body font-size-dialog-body">
          <label className="font-size-setting">
            <span>
              <strong>{t("fontDialog.panels")}</strong>
              <small>{t("fontDialog.panelsHint")}</small>
            </span>
            <input
              type="range"
              min={PANEL_FONT_SIZE.min}
              max={PANEL_FONT_SIZE.max}
              value={panelSize}
              onChange={(event) => setPanelSize(event.target.valueAsNumber)}
            />
            <input
              aria-label={t("fontDialog.panelFontSize")}
              className="font-size-number"
              type="number"
              min={PANEL_FONT_SIZE.min}
              max={PANEL_FONT_SIZE.max}
              value={panelSize}
              onChange={(event) =>
                updateNumberInput(
                  event.target.value,
                  event.target.valueAsNumber,
                  setPanelSize,
                  PANEL_FONT_SIZE.min,
                  PANEL_FONT_SIZE.max,
                )
              }
            />
            <span className="font-size-unit">px</span>
          </label>

          <FontFamilyField
            id="panel-font-family"
            label={t("fontDialog.interfaceFont")}
            hint={t("fontDialog.interfaceFontHint")}
            role="ui"
            value={panelFamily}
            fonts={uiFonts}
            onChange={setPanelFamily}
          />

          <label className="font-size-setting">
            <span>
              <strong>{t("fontDialog.buffer")}</strong>
              <small>{t("fontDialog.bufferHint")}</small>
            </span>
            <input
              type="range"
              min={BUFFER_FONT_SIZE.min}
              max={BUFFER_FONT_SIZE.max}
              value={bufferSize}
              onChange={(event) => setBufferSize(event.target.valueAsNumber)}
            />
            <input
              aria-label={t("fontDialog.bufferFontSize")}
              className="font-size-number"
              type="number"
              min={BUFFER_FONT_SIZE.min}
              max={BUFFER_FONT_SIZE.max}
              value={bufferSize}
              onChange={(event) =>
                updateNumberInput(
                  event.target.value,
                  event.target.valueAsNumber,
                  setBufferSize,
                  BUFFER_FONT_SIZE.min,
                  BUFFER_FONT_SIZE.max,
                )
              }
            />
            <span className="font-size-unit">px</span>
          </label>

          <FontFamilyField
            id="buffer-font-family"
            label={t("fontDialog.bufferFont")}
            hint={t("fontDialog.bufferFontHint")}
            role="mono"
            value={bufferFamily}
            fonts={monoFonts}
            onChange={setBufferFamily}
          />

          {/* A div, not a label: the row holds two controls of its own. */}
          <div className="font-size-setting cursor-setting">
            <span>
              <strong>{t("fontDialog.cursor")}</strong>
              <small>{t("fontDialog.cursorHint")}</small>
            </span>
            <select
              aria-label={t("fontDialog.cursorStyle")}
              className="cursor-style-select"
              value={cursor}
              onChange={(event) => setCursor(event.target.value as CursorStyle)}
            >
              <option value="block">{t("fontDialog.cursorBlock")}</option>
              <option value="underline">
                {t("fontDialog.cursorUnderline")}
              </option>
              <option value="bar">{t("fontDialog.cursorBar")}</option>
            </select>
            <label className="cursor-blink">
              <input
                type="checkbox"
                checked={blink}
                onChange={(event) => setBlink(event.target.checked)}
              />
              {t("fontDialog.blink")}
            </label>
          </div>

          <label className="font-size-setting gpu-setting">
            <span>
              <strong>{t("fontDialog.gpu")}</strong>
              <small>{t("fontDialog.gpuHint")}</small>
            </span>
            <span className="cursor-blink">
              <input
                type="checkbox"
                checked={gpu}
                onChange={(event) => setGpu(event.target.checked)}
              />
              {t("common.enabled")}
            </span>
          </label>

          <label className="font-size-setting scrollback-setting">
            <span>
              <strong>{t("fontDialog.scrollback")}</strong>
              <small>
                {t("fontDialog.scrollbackHint", {
                  mb: Math.max(1, Math.round(scrollbackMegabytes(scrollback))),
                })}
              </small>
            </span>
            <input
              aria-label={t("fontDialog.scrollbackLines")}
              className="scrollback-number"
              type="number"
              min={TERMINAL_SCROLLBACK.min}
              max={TERMINAL_SCROLLBACK.max}
              step={1000}
              value={scrollback}
              onChange={(event) =>
                updateNumberInput(
                  event.target.value,
                  event.target.valueAsNumber,
                  setScrollback,
                  TERMINAL_SCROLLBACK.min,
                  TERMINAL_SCROLLBACK.max,
                )
              }
            />
            <span className="font-size-unit">{t("fontDialog.lines")}</span>
          </label>
        </div>
        <div className="dialog-footer font-size-dialog-footer">
          <button
            type="button"
            className="btn font-size-reset"
            onClick={() => {
              setPanelSize(PANEL_FONT_SIZE.default);
              setBufferSize(BUFFER_FONT_SIZE.default);
              setPanelFamily("");
              setBufferFamily("");
              setScrollback(TERMINAL_SCROLLBACK.default);
              setCursor("block");
              setBlink(true);
              setGpu(true);
            }}
          >
            {t("fontDialog.resetDefaults")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn is-primary">
            {t("common.apply")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/**
 * A family name with the installed fonts as suggestions. Deliberately a text
 * field rather than a closed list: `fonts.ts` can only offer the families it
 * knows to probe for, and a terminal user's face of choice is as likely to be
 * a private Nerd Font build as one of them. Empty means the platform default,
 * and the field shows its own value in the font it names.
 */
function FontFamilyField({
  id,
  label,
  hint,
  role,
  value,
  fonts,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  role: "mono" | "ui";
  value: string;
  fonts: string[];
  onChange: (family: string) => void;
}) {
  const listId = `${id}-list`;
  const systemMonoFamily = useStore((s) => s.systemMonoFamily);
  const symbolFontFamilies = useStore((s) => s.symbolFontFamilies);
  const t = useT();
  return (
    <label className="font-size-setting">
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input
        aria-label={label}
        className="font-family-input"
        type="text"
        list={listId}
        spellCheck={false}
        autoComplete="off"
        placeholder={t("fontDialog.systemDefault")}
        value={value}
        style={{
          fontFamily: fontStack(
            role,
            value,
            role === "mono" ? symbolFontFamilies : [],
            systemMonoFamily,
          ),
        }}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {fonts.map((font) => (
          <option key={font} value={font} />
        ))}
      </datalist>
    </label>
  );
}
