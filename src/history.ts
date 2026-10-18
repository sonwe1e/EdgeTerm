import * as api from "./api";
import type { CommandHistoryEntry } from "./api";

const MAX_ENTRIES = 5000;
const MAX_SUGGESTIONS = 8;
/**
 * A candidate must add at least this many characters beyond the input:
 * picking `cd ..` for `cd .` costs more keystrokes than finishing it, and
 * such rows only hide the output underneath.
 */
const MIN_GAIN = 3;
/**
 * Typed characters (whitespace excluded) before suggestions appear: a single
 * letter matches too much of the history to be worth a popup.
 */
const MIN_INPUT = 2;

/** One row of the completion popup. */
export interface CommandSuggestion {
  command: string;
  /** Where the typed input occurs in the command, for highlighting. */
  matchStart: number;
}

// Score components. Prefix matches outrank substring matches, same-host
// outranks other hosts, and recency (a Unix-ms timestamp, ~2e12) breaks ties;
// the sum stays well inside Number.MAX_SAFE_INTEGER (9e15).
const PREFIX_BONUS = 4e15;
const HOST_BONUS = 2e15;

/**
 * In-memory mirror of the persisted command history, shared by every terminal.
 * Reads are answered from memory on each keystroke; writes update memory
 * immediately and persist through the backend in the background.
 *
 * Suggestion lookup is IDE-style: once `MIN_INPUT` characters are typed,
 * every entry containing the typed input and extending it by at least
 * `MIN_GAIN` characters is a candidate, ranked prefix-first, same-host-first,
 * most-recent-first. The list stays small enough that a linear scan per
 * keystroke is well under a millisecond.
 */
class CommandHistory {
  private entries: CommandHistoryEntry[] = [];
  private loadStarted = false;
  private loadingChanges: (() => void)[] | null = null;

  load() {
    if (this.loadStarted) return;
    this.loadStarted = true;
    this.loadingChanges = [];
    api.listCommandHistory().then(
      (entries) => {
        const changes = this.loadingChanges;
        this.loadingChanges = null;
        this.entries = entries;
        // The snapshot may predate typing, forgetting or clearing while
        // IPC was in flight. Replay those local edits without persisting twice.
        for (const change of changes ?? []) change();
      },
      () => {
        // Allow a retry on the next call when the backend was not ready.
        this.loadingChanges = null;
        this.loadStarted = false;
      },
    );
  }

  record(command: string, host: string) {
    const lastUsed = Date.now();
    const count = (this.entries.find(
      (entry) => entry.command === command && entry.host === host,
    )?.count ?? 0) + 1;
    this.change(() => {
      const existing = this.entries.find(
        (entry) => entry.command === command && entry.host === host,
      );
      if (existing) {
        // The concurrent snapshot may already include this record. Merge
        // the observed state instead of counting it again or moving it back.
        existing.count = Math.max(existing.count, count);
        existing.lastUsed = Math.max(existing.lastUsed, lastUsed);
      } else {
        this.entries.push({ command, host, count, lastUsed });
        if (this.entries.length > MAX_ENTRIES) {
          let oldest = 0;
          for (let i = 1; i < this.entries.length; i += 1) {
            if (this.entries[i].lastUsed < this.entries[oldest].lastUsed) {
              oldest = i;
            }
          }
          this.entries.splice(oldest, 1);
        }
      }
    });
    void api.recordCommand(command, host).catch(() => undefined);
  }

  suggest(input: string, host: string): CommandSuggestion[] {
    if (input.trim().length < MIN_INPUT) return [];
    // The same command may be remembered for several hosts; keep only the
    // best-scoring occurrence of each command text.
    const byCommand = new Map<
      string,
      { score: number; matchStart: number }
    >();
    for (const entry of this.entries) {
      if (entry.command.length < input.length + MIN_GAIN) continue;
      const matchStart = entry.command.indexOf(input);
      if (matchStart === -1) continue;
      const score =
        (matchStart === 0 ? PREFIX_BONUS : 0) +
        (entry.host === host ? HOST_BONUS : 0) +
        entry.lastUsed;
      const seen = byCommand.get(entry.command);
      if (!seen || score > seen.score) {
        byCommand.set(entry.command, { score, matchStart });
      }
    }
    return [...byCommand.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, MAX_SUGGESTIONS)
      .map(([command, { matchStart }]) => ({ command, matchStart }));
  }

  /** Forgets `command` on every host (suggestions are per command text). */
  remove(command: string) {
    this.change(() => {
      this.entries = this.entries.filter((entry) => entry.command !== command);
    });
    void api.deleteCommandHistory(command).catch(() => undefined);
  }

  clear(): Promise<void> {
    this.change(() => {
      this.entries = [];
    });
    return api.clearCommandHistory();
  }

  private change(update: () => void) {
    update();
    this.loadingChanges?.push(update);
  }
}

export const commandHistory = new CommandHistory();
