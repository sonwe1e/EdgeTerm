import type { Dispatch, SetStateAction } from "react";
import type { Translate } from "../../i18n";
import type { RepeatSettings, ScheduleState } from "../../senderSchedule";
import { REPEAT_LIMITS, stopSchedule } from "../../senderSchedule";
import { firstLine } from "../../senderUnits";
import { type LineEnding } from "../../types";
import { Icon } from "../icons";
import { describeEvery } from "./senderShared";

interface Props {
  schedule: ScheduleState | null;
  t: Translate;
  now: number;
  repeat: RepeatSettings;
  setRepeat: Dispatch<SetStateAction<RepeatSettings>>;
  text: string;
  beginRepeat: (commandText: string, commandEnding: LineEnding) => void;
  ending: LineEnding;
}

export function SenderRepeat({
  schedule,
  t,
  now,
  repeat,
  setRepeat,
  text,
  beginRepeat,
  ending,
}: Props) {
  return (
    <div
      className={`sender-repeat${schedule ? " is-running" : ""}`}
      role="group"
      aria-label={t("sender.repeat")}
    >
      <Icon name="watch" />
      {schedule ? (
        <>
          <span className="sender-repeat-text">
            {t("sender.repeatingWord")} <code>{firstLine(schedule.spec.text)}</code>{" "}
            {t("sender.everyWord")} {describeEvery(schedule.spec.every)}
            {" · "}
            {schedule.spec.target === "all" ? t("sender.allSessionsWord") : t("sender.oneSession")}
            {" · "}
            {t("sender.sent", { count: schedule.sent })}
            {schedule.spec.times > 0 ? t("sender.of", { total: schedule.spec.times }) : ""}
            {schedule.nextAt !== null
              ? t("sender.nextIn", {
                  seconds: Math.max(0, Math.ceil((schedule.nextAt - now) / 1000)),
                })
              : t("sender.sendingNow")}
          </span>
          <button type="button" className="sender-save-btn" onClick={stopSchedule}>
            {t("sender.stop")}
          </button>
        </>
      ) : (
        <>
          <label className="sender-field">
            <span>{t("sender.every")}</span>
            <input
              className="sender-repeat-number"
              type="number"
              min={REPEAT_LIMITS.minEvery}
              max={REPEAT_LIMITS.maxEvery}
              value={repeat.every}
              aria-label={t("sender.secondsBetween")}
              onChange={(event) => setRepeat({ ...repeat, every: Number(event.target.value) })}
            />
            <span>s</span>
          </label>
          <label className="sender-field">
            <span>{t("sender.times")}</span>
            <input
              className="sender-repeat-number"
              type="number"
              min={0}
              max={REPEAT_LIMITS.maxTimes}
              value={repeat.times}
              aria-label={t("sender.numberOfSends")}
              onChange={(event) => setRepeat({ ...repeat, times: Number(event.target.value) })}
            />
            <span>{t("sender.untilStopped")}</span>
          </label>
          <span className="sender-repeat-hint">{t("sender.repeatHint")}</span>
          <button
            type="button"
            className="sender-save-btn"
            disabled={text.length === 0}
            onClick={() => beginRepeat(text, ending)}
          >
            {t("sender.start")}
          </button>
        </>
      )}
    </div>
  );
}
