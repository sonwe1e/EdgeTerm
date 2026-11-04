/** Use the browser's editing operation so references participate in native undo. */
export function editDraft(
  input: HTMLTextAreaElement | null,
  text: string,
  update: (value: string) => void,
  append = true,
) {
  if (!input) return;
  input.focus();
  const previous = input.value;
  const insertion = append && previous ? `\n\n${text}` : text;
  input.setSelectionRange(append ? previous.length : 0, previous.length);
  // setRangeText / assigning value resets the native undo transaction. Chromium,
  // WebKit and Firefox still expose insertText for this editing use case.
  const edited = input.ownerDocument.execCommand(
    insertion ? "insertText" : "delete",
    false,
    insertion,
  );
  update(edited ? input.value : append ? previous + insertion : insertion);
}
