/**
 * Unsaved editor content. Unlike the file listings and probes around it, this
 * is not a cache: until the user saves, the draft is the only copy of the
 * edit. It therefore lives in the app data directory (one file per draft,
 * written by the Rust side) instead of a webview storage budget that evicts
 * the oldest entry when it fills up.
 *
 * Every call reports whether it persisted. The editor shows a failed draft as
 * "not stored" and refuses to close the tab silently; nothing here guesses
 * that the content is safe.
 *
 * The in-memory map is a mirror of what the backend confirmed. It exists so
 * `openFile` can ask "is there a draft?" synchronously after the initial
 * load, and so the recovery list can render without a round trip per render.
 */

import { commands } from "../bindings";
import type { Draft, DraftSummary, DraftWriteResult } from "./draftTypes";

export const LEGACY_STORAGE_KEY = "edgeterm.workbench.drafts";

const cache = new Map<string, Draft>();
let loaded = false;
let loadError: string | null = null;
let summary: DraftSummary = { dir: "", bytes: 0, unreadable: 0 };

export function draftKey(workspaceId: string, absolutePath: string): string {
  return `${workspaceId}::${absolutePath}`;
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return typeof error === "string" ? error : "unknown error";
}

function replaceCache(drafts: Draft[]): void {
  cache.clear();
  for (const draft of drafts) cache.set(draft.docId, draft);
}

/** Loads every draft once; a failure is remembered rather than retried on
 * every keystroke. */
export async function ensureDraftsLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const result = (await commands.draftList()) as unknown as {
      drafts: Draft[];
      dir: string;
      bytes: number;
      unreadable: number;
    };
    replaceCache(result.drafts ?? []);
    summary = {
      dir: result.dir ?? "",
      bytes: result.bytes ?? 0,
      unreadable: result.unreadable ?? 0,
    };
    loadError = null;
    loaded = true;
  } catch (error) {
    loadError = errorText(error);
  }
}

/** Re-reads the store, for the recovery list and after a failed write. */
export async function reloadDrafts(): Promise<DraftWriteResult> {
  loaded = false;
  await ensureDraftsLoaded();
  return { ok: loadError === null, error: loadError };
}

export function cachedDraft(docId: string): Draft | null {
  return cache.get(docId) ?? null;
}

export function cachedDrafts(): Draft[] {
  return [...cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function draftsForWorkspace(workspaceId: string): Draft[] {
  return cachedDrafts().filter((draft) => draft.workspaceId === workspaceId);
}

export function draftCount(): number {
  return cache.size;
}

export function draftBytes(): number {
  return summary.bytes;
}

export function draftUnreadable(): number {
  return summary.unreadable;
}

export function draftDirectory(): string {
  return summary.dir;
}

export function draftLoadError(): string | null {
  return loadError;
}

export async function saveDraft(draft: Draft): Promise<DraftWriteResult> {
  try {
    const saved = (await commands.draftSave(draft)) as unknown as Draft;
    cache.set(saved.docId, saved);
    summary = { ...summary, bytes: totalBytes() };
    return { ok: true, error: null };
  } catch (error) {
    // Nothing is removed from the mirror: the previous draft is still on
    // disk, and the caller must not treat this edit as stored.
    return { ok: false, error: errorText(error) };
  }
}

export async function removeDraft(docId: string): Promise<DraftWriteResult> {
  try {
    await commands.draftDelete(docId);
    cache.delete(docId);
    summary = { ...summary, bytes: totalBytes() };
    return { ok: true, error: null };
  } catch (error) {
    // The stale draft stays visible so it can be discarded again; keeping it
    // in the mirror is what stops the UI from claiming it is gone.
    return { ok: false, error: errorText(error) };
  }
}

function totalBytes(): number {
  let bytes = 0;
  for (const draft of cache.values()) bytes += draft.content.length;
  return bytes;
}

/**
 * Moves drafts written by the previous (localStorage) version onto disk.
 * The legacy key is only removed once every draft was saved, so a failure
 * leaves the old copy intact.
 */
export async function importLegacyDrafts(): Promise<number> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return 0;
  }
  if (!raw) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object") return 0;
  let imported = 0;
  let failed = false;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    const draft = value as Partial<Draft>;
    if (
      typeof draft.docId !== "string" ||
      typeof draft.workspaceId !== "string" ||
      typeof draft.absolutePath !== "string" ||
      typeof draft.content !== "string" ||
      typeof draft.baseHash !== "string" ||
      typeof draft.updatedAt !== "number"
    ) {
      continue;
    }
    const result = await saveDraft({
      docId: draft.docId,
      workspaceId: draft.workspaceId,
      serverKey: draft.serverKey ?? "",
      serverLabel: draft.serverLabel ?? "",
      projectName: draft.projectName ?? "",
      path: draft.path ?? "",
      absolutePath: draft.absolutePath,
      content: draft.content,
      baseHash: draft.baseHash,
      updatedAt: draft.updatedAt,
    });
    if (result.ok) imported += 1;
    else failed = true;
  }
  if (!failed) {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Leaving the old copy is harmless: the next start imports it again.
    }
  }
  return imported;
}

/** Test seam: the module keeps process-wide state. */
export function resetDraftsForTests(): void {
  cache.clear();
  loaded = false;
  loadError = null;
  summary = { dir: "", bytes: 0, unreadable: 0 };
}
