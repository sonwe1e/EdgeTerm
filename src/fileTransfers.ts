import { create } from "zustand";
import * as api from "./api";

export type TransferView = api.FileTransfer & { bytesPerSecond: number; sampledAt: number };
interface State {
  jobs: Record<string, TransferView>;
  update: (job: api.FileTransfer) => void;
  mergeSnapshot: (jobs: api.FileTransfer[]) => void;
  remove: (id: string) => void;
}
const removed = new Set<string>();
function view(job: api.FileTransfer, old: TransferView | undefined, now: number): TransferView {
  const elapsed = old ? (now - old.sampledAt) / 1000 : 0;
  const instant = old && elapsed > 0 && job.transferred >= old.transferred
    ? (job.transferred - old.transferred) / elapsed : 0;
  const bytesPerSecond = job.status === "running"
    ? old && old.status === "running" ? old.bytesPerSecond * 0.75 + instant * 0.25 : instant
    : 0;
  return { ...job, bytesPerSecond, sampledAt: now };
}

export const useFileTransfers = create<State>((set) => ({
  jobs: {},
  update: (job) => set((state) => {
    if (removed.has(job.id)) return state;
    const old = state.jobs[job.id];
    if (old && old.revision >= job.revision) return state;
    const now = performance.now();
    return { jobs: { ...state.jobs, [job.id]: view(job, old, now) } };
  }),
  mergeSnapshot: (snapshot) => set((state) => {
    let jobs: Record<string, TransferView> | undefined;
    const now = performance.now();
    for (const job of snapshot) {
      if (removed.has(job.id)) continue;
      const old = (jobs ?? state.jobs)[job.id];
      if (old && old.revision >= job.revision) continue;
      // One clone and notification for the entire initial snapshot. Live
      // events received while listing retain their newer revision.
      jobs ??= { ...state.jobs };
      jobs[job.id] = view(job, old, now);
    }
    return jobs ? { jobs } : state;
  }),
  remove: (id) => set((state) => {
    removed.add(id);
    if (removed.size > 512) removed.delete(removed.values().next().value!);
    const jobs = { ...state.jobs };
    delete jobs[id];
    return { jobs };
  }),
}));

export async function startTransferSubscription(): Promise<() => void> {
  const stop = await api.onFileTransfer((job) => useFileTransfers.getState().update(job));
  let stopRemoved: (() => void) | undefined;
  try {
    stopRemoved = await api.onFileTransferRemoved((id) => useFileTransfers.getState().remove(id));
    useFileTransfers.getState().mergeSnapshot(await api.listFileTransfers());
  } catch (error) {
    stop();
    stopRemoved?.();
    throw error;
  }
  return () => { stop(); stopRemoved?.(); };
}

export const transferActive = (status: api.FileTransfer["status"]) =>
  ["queued", "running", "pausing", "paused", "retrying", "cancelling"].includes(status);

export function transferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}
