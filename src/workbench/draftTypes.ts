/**
 * The shape of a persisted draft and of the answers the draft commands give.
 * Kept apart from `drafts.ts` so tests and views can import the types without
 * pulling in the module's cache.
 */

export interface Draft {
  docId: string;
  workspaceId: string;
  serverKey: string;
  serverLabel: string;
  projectName: string;
  path: string;
  absolutePath: string;
  content: string;
  baseHash: string;
  updatedAt: number;
}

export interface DraftSummary {
  dir: string;
  bytes: number;
  unreadable: number;
}

export interface DraftWriteResult {
  ok: boolean;
  error: string | null;
}
