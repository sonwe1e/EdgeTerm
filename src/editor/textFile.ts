import { commands } from "../bindings";
import type { TextFile } from "./editorTypes";

/**
 * The built-in editor's IPC surface: read and write one text file, local or on
 * a connected session. Every persisted field is normalized on the Rust side,
 * so a missing field from an older file cannot turn into `undefined` deep
 * inside a view.
 */

export const readText = (sessionId: string | null, path: string): Promise<TextFile> =>
  commands.projectReadText(sessionId, path) as Promise<TextFile>;

export const writeText = (
  sessionId: string | null,
  request: {
    path: string;
    content: string;
    expectedHash: string | null;
    eol: string;
    bom: boolean;
    force?: boolean;
    encoding?: string;
  },
): Promise<{
  path: string;
  hash: string;
  size: number;
  backup: string | null;
  temp: string | null;
  uncertain: boolean;
  note: string;
}> =>
  commands.projectWriteText(sessionId, request).then((result) => ({
    path: result.path,
    hash: result.hash,
    size: result.size,
    backup: result.backup ?? null,
    temp: result.temp ?? null,
    uncertain: result.uncertain ?? false,
    note: result.note ?? "",
  }));
