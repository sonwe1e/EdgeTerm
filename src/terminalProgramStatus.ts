/** OSC 7501, revision 0.4: https://www.superlogical.com/rex/docs/build/program-status */
type ProgramState = "idle" | "working" | "blocked" | "done" | "error" | "clear";
export type ProgramActivity = "idle" | "running" | "complete";

const states = new Set<string>(["idle", "working", "blocked", "done", "error", "clear"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Validate even unused text fields; never display or retain their contents. */
function validText(value: string, limit: number): boolean {
  if (value.length > 4 * Math.ceil(limit / 3)) return false;
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    return bytes.length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(decoder.decode(bytes));
  } catch {
    return false;
  }
}

function parseReport(data: string): { id: string; state: ProgramState; app: string | null } | null {
  // Leave room for ESC ] 7501 ; and the two-byte ST terminator.
  if (data.length > 4087 || encoder.encode(data).length > 4087) return null;
  const fields = new Map<string, string>();
  for (const pair of data.split(":")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key.length > 16) return null;
    if (key === "id" && !/^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/.test(value)) {
      return null;
    }
    if (!/^[a-z]+$/.test(key) || !/^[A-Za-z0-9_.,+/=-]*$/.test(value)) continue;
    if (
      (key === "msg" && !validText(value, 2048)) ||
      (key === "title" && !validText(value, 192)) ||
      (key === "app" && !/^[A-Za-z0-9_.+-]{1,32}$/.test(value)) ||
      (key === "id" && value.length > 128)
    ) {
      return null;
    }
    fields.set(key, value);
  }
  const state = fields.get("state");
  if (!state || !states.has(state)) return null;
  const id = fields.get("id");
  return { state: state as ProgramState, id: id ?? "", app: fields.get("app") ?? null };
}

/** Per-terminal records. Child clears cannot stop a still-running sibling. */
export class TerminalProgramStatus {
  private readonly records = new Map<string, ProgramState>();
  private reportedApp: string | null = null;

  /** Application identity from the last accepted report, never from invalid input. */
  get app(): string | null {
    return this.reportedApp;
  }

  clear() {
    this.records.clear();
    this.reportedApp = null;
  }

  update(data: string): ProgramActivity | null {
    const report = parseReport(data);
    if (!report) return null;
    const { id, state } = report;
    this.reportedApp = state === "clear" ? null : report.app;
    if (state === "clear") {
      for (const key of this.records.keys()) {
        if (id === "" || key === id || key.startsWith(`${id}/`)) this.records.delete(key);
      }
    } else {
      // Map insertion order tracks the last update; the protocol allows a
      // bounded record set with least-recently-updated eviction.
      this.records.delete(id);
      this.records.set(id, state);
      if (this.records.size > 256) this.records.delete(this.records.keys().next().value!);
    }
    let activity: ProgramActivity = "idle";
    for (const value of this.records.values()) {
      // The existing AI "complete" treatment means needs review, not success.
      if (value === "blocked" || value === "done" || value === "error") return "complete";
      if (value === "working") activity = "running";
    }
    return activity;
  }
}
