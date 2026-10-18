import type { EditorState } from "@codemirror/state";

/**
 * Document state that outlives its DOM view. Kept apart from codemirror.ts so
 * the workbench store can release a document without pulling the editor
 * bundle into the main chunk.
 */
export interface SavedEditor {
  state: EditorState;
  scrollTop: number;
}

const savedEditors = new Map<string, SavedEditor>();
/**
 * Ids whose state was explicitly released (closed tab, evicted buffer).
 * Their unmount runs after the release, so storing must be suppressed then;
 * opening the document again clears the suppression.
 */
const suppressed = new Set<string>();
const MAX_SAVED_EDITORS = 16;

/** Releases the remembered state for a document that is no longer open. */
export function forgetEditorState(docId: string): void {
  savedEditors.delete(docId);
  suppressed.add(docId);
  // A closed document that is never reopened must not accumulate an id here.
  if (suppressed.size > 64) {
    const oldest = suppressed.values().next().value;
    if (oldest !== undefined) suppressed.delete(oldest);
  }
}

/**
 * Returns the state to reuse when a view is mounted. A state only matches if
 * its text is still the document's text: a reload, a conflict overwrite or a
 * draft restored from another version must not inherit its history.
 */
export function claimEditorState(docId: string, content: string): SavedEditor | undefined {
  suppressed.delete(docId);
  const saved = savedEditors.get(docId);
  if (!saved) return undefined;
  if (saved.state.doc.toString() !== content) {
    savedEditors.delete(docId);
    return undefined;
  }
  return saved;
}

/** Remembers the latest state and reading position of a mounted document. */
export function rememberEditorState(docId: string, state: EditorState, scrollTop: number): void {
  // The unmount of a closed or evicted document runs after the release; its
  // state must not come back through this path.
  if (suppressed.has(docId)) return;
  if (savedEditors.size >= MAX_SAVED_EDITORS && !savedEditors.has(docId)) {
    const oldest = savedEditors.keys().next().value;
    if (oldest !== undefined) savedEditors.delete(oldest);
  }
  // Re-insert so the map's order stays least-recently-saved last.
  savedEditors.delete(docId);
  savedEditors.set(docId, { state, scrollTop });
}
