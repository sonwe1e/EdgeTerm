import { RESOURCE_MONITOR_KEY } from "./persistKeys";
export interface MonitorSettings {
  enabled: boolean;
  intervalSeconds: number;
}
export function readMonitorSettings(): MonitorSettings {
  let value: Partial<MonitorSettings> | null = null;
  try {
    value = JSON.parse(localStorage.getItem(RESOURCE_MONITOR_KEY) ?? "null");
  } catch {}
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
    intervalSeconds:
      Number.isInteger(value?.intervalSeconds) &&
      value!.intervalSeconds! >= 1 &&
      value!.intervalSeconds! <= 30
        ? value!.intervalSeconds!
        : 2,
  };
}
/** Returns whether the value reached storage; memory-only applies otherwise. */
export function saveMonitorSettings(value: MonitorSettings): boolean {
  try {
    localStorage.setItem(RESOURCE_MONITOR_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
