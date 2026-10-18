import { useEffect, useState } from "react";
import { create } from "zustand";
import * as api from "../api";
import { errorText } from "../errorInfo";
import { t } from "../i18n";
import { connectedTabFor } from "./session";
import { samplingIntervalMs, staleAfterMs } from "./model";
import type { ServerIdentity } from "./types";

export interface HostSample {
  key: string;
  server: ServerIdentity["server"];
  metrics: api.ResourceMetrics | null;
  at: number;
  error: string | null;
}

interface HostSampleState {
  samples: Record<string, HostSample>;
  setSample: (sample: HostSample) => void;
}

export const useHostSamples = create<HostSampleState>((set) => ({
  samples: {},
  setSample(sample) {
    set((state) => ({ samples: { ...state.samples, [sample.key]: sample } }));
  },
}));

/** One sample per host at a time, shared by every mounted overview. */
const inFlight = new Set<string>();

async function sampleHost(host: ServerIdentity): Promise<void> {
  if (inFlight.has(host.key)) return;
  const tab = connectedTabFor(host.server);
  if (!tab) {
    useHostSamples.getState().setSample({
      key: host.key,
      server: host.server,
      metrics: useHostSamples.getState().samples[host.key]?.metrics ?? null,
      at: useHostSamples.getState().samples[host.key]?.at ?? 0,
      error: t("wb.noSession"),
    });
    return;
  }
  inFlight.add(host.key);
  try {
    const metrics = await api.sampleResources(tab.info.id, crypto.randomUUID());
    useHostSamples.getState().setSample({
      key: host.key,
      server: host.server,
      metrics,
      at: Date.now(),
      error: null,
    });
  } catch (error) {
    useHostSamples.getState().setSample({
      key: host.key,
      server: host.server,
      metrics: useHostSamples.getState().samples[host.key]?.metrics ?? null,
      at: useHostSamples.getState().samples[host.key]?.at ?? 0,
      error: errorText(error),
    });
  } finally {
    inFlight.delete(host.key);
  }
}

/**
 * Samples each host while the overview is mounted. Visible windows ask every
 * five seconds and hidden ones every thirty, so a background workbench does
 * not keep several servers busy with shell commands.
 */
export function useHostSampling(hosts: ServerIdentity[]): void {
  const signature = hosts.map((host) => host.key).join("|");
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  // The host list is compared by its stable identity signature; different
  // arrays with the same servers must not restart the timer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by signature
  useEffect(() => {
    const list = hosts;
    if (list.length === 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        await Promise.all(list.map((host) => sampleHost(host)));
      } else {
        // A hidden window only refreshes a stale sample; it does not poll.
        const samples = useHostSamples.getState().samples;
        await Promise.all(
          list
            .filter((host) => {
              const sample = samples[host.key];
              return !sample?.at || Date.now() - sample.at > staleAfterMs(false);
            })
            .map((host) => sampleHost(host)),
        );
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), samplingIntervalMs(!document.hidden));
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // The host list is compared by its stable identity signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, visible]);
}
