import { useEffect, useRef, useState } from "react";
import { errorText } from "../../errorInfo";
import type { Translate } from "../../i18n";
import {
  clampRepeat,
  loadRepeatSettings,
  startSchedule,
  storeRepeatSettings,
  useSchedule,
} from "../../senderSchedule";
import { newStopSignal, sendUnits, type StopSignal } from "../../senderSend";
import { buildUnits, type SendUnit } from "../../senderUnits";
import type { Tab } from "../../store";
import { useStore } from "../../store";
import { isFileSession, type LineEnding } from "../../types";
import { Target } from "./senderShared";

interface Options {
  tabs: Tab[];
  activeId: string | null;
  setStatus: (status: string) => void;
  t: Translate;
  activeTab: Tab | undefined;
}

export function useSenderSend({ tabs, activeId, setStatus, t, activeTab }: Options) {
  const [target, setTarget] = useState<Target>("current");
  const [running, setRunning] = useState(false);
  // Which saved command is on its way out, and how far through its lines.
  // The quickbar marks that command's tag; the compose row reads the counter.
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sentLines, setSentLines] = useState(0);
  const [totalLines, setTotalLines] = useState(0);
  // Repeat: the strip under the compose row and its settings. The schedule
  // itself lives outside the panel (`senderSchedule.ts`), so hiding the
  // panel does not stop a keepalive; the strip shows and stops it.
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [repeat, setRepeat] = useState(loadRepeatSettings);
  const preferencesRevision = useStore((s) => s.panelPreferencesRevision);
  useEffect(() => {
    setRepeat(loadRepeatSettings());
  }, [preferencesRevision]);
  const schedule = useSchedule();
  const [now, setNow] = useState(() => Date.now());
  /** Abandons the send in progress between its lines. */
  const stopRef = useRef<StopSignal | null>(null);

  // The countdown to the next scheduled send.
  useEffect(() => {
    if (!schedule) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [schedule]);

  // A manual send does not outlive the panel; a schedule does.
  useEffect(() => () => stopRef.current?.stop(), []);

  const targets = (): string[] => {
    if (target === "all") {
      return tabs.filter((tab) => !isFileSession(tab.info.kind)).map((tab) => tab.info.id);
    }
    return tabs.some((tab) => tab.info.id === activeId && !isFileSession(tab.info.kind)) && activeId
      ? [activeId]
      : [];
  };

  /**
   * Sends `commandText`. `commandId` names the saved command it came from, so
   * the quickbar can mark that tag while the send is in flight; a typed
   * command leaves it null and only the compose row's counter shows.
   */
  const sendCommand = async (
    commandText: string,
    commandEnding: LineEnding,
    commandId?: string,
  ) => {
    if (running) return;
    const targetIds = targets();
    if (targetIds.length === 0) {
      setStatus(t("sender.noSession"));
      return;
    }

    const units: SendUnit[] = buildUnits(commandText, commandEnding);
    if (units.length === 0) return;

    const stop = newStopSignal();
    stopRef.current = stop;
    setRunning(true);
    setSendingId(commandId ?? null);
    setSentLines(0);
    setTotalLines(units.length);
    try {
      const { sent, skipped } = await sendUnits(
        targetIds,
        units,
        commandEnding,
        stop,
        (done, total) => {
          setSentLines(done);
          setTotalLines(total);
        },
      );
      if (sent.length === 0) {
        setStatus(t("sender.blocked"));
      } else if (stop.stopped) {
        setStatus(t("sender.stopped"));
      } else {
        const what =
          units.length > 1
            ? t("sender.sentLines", { count: units.length })
            : t("sender.sentCommand");
        setStatus(
          skipped.length === 0
            ? t("sender.sentOnly", { what })
            : t("sender.sentSkipped", { what, count: skipped.length }),
        );
      }
    } catch (e) {
      setStatus(t("sender.error", { error: errorText(e) }));
    } finally {
      stopRef.current = null;
      setRunning(false);
      setSendingId(null);
      setSentLines(0);
      setTotalLines(0);
    }
  };

  const stopSending = () => stopRef.current?.stop();

  /** Starts repeating a command with the strip's interval and count. */
  const beginRepeat = (commandText: string, commandEnding: LineEnding) => {
    const settings = clampRepeat(repeat);
    setRepeat(settings);
    storeRepeatSettings(settings);
    const sessionId =
      target === "current" && activeTab && !isFileSession(activeTab.info.kind)
        ? activeTab.info.id
        : null;
    const problem = startSchedule({
      text: commandText,
      ending: commandEnding,
      target,
      sessionId,
      every: settings.every,
      times: settings.times,
    });
    if (problem) {
      setStatus(t("sender.scheduleProblem", { problem }));
      return;
    }
    setRepeatOpen(true);
  };

  return {
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
  };
}
