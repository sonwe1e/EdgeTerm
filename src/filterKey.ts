/**
 * Whether a key event is the one that opens a list's filter box. Every list in
 * the app uses "/" — the key that types a search rather than a character meant
 * for a name — and never claims it while a shortcut modifier is held, so
 * Ctrl-/, Cmd-/ and Alt-/ keep whatever meaning they have elsewhere.
 *
 * One function rather than five copies: the file panel, each dual pane, the
 * session tree and the saved-command list all ask this question.
 */
export function opensFilter(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey;
}
