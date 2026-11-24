/**
 * Whether Connect must save the profile before it opens the session.
 *
 * Saving keeps the profile in the tree and stores its credentials, so it is
 * the default. A one-off local shell is the exception — the tree already has
 * its built-in row — but a startup command is remembered against a profile,
 * so typing one turns the one-off shell into a profile after all.
 */
export function keepsConnectProfile(input: {
  kind: string;
  name: string;
  existingId?: string;
  startup: string;
}): boolean {
  const quickLocal = input.kind === "local" && !input.existingId;
  return (input.name !== "" && !quickLocal) || input.startup.trim() !== "";
}
