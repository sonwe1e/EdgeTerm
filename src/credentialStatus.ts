import { commands, type CredentialStoreStatus } from "./bindings";
import type { MessageKey } from "./i18n";

// How the backend protects saved passwords right now (`credential_store_status`).
// The session editor asks once per open and notes the answer where a password
// is typed, so a password that is not kept across restarts is not a surprise.

export type CredentialHintKey = Extract<
  MessageKey,
  "session.secretsRunOnlyPortable" | "session.secretsRunOnlyNoKeyStore"
>;

/** Asks the backend; null when it cannot answer, and the note stays away. */
export async function fetchCredentialStoreStatus(): Promise<CredentialStoreStatus | null> {
  try {
    return await commands.credentialStoreStatus();
  } catch (error) {
    console.error(error);
    return null;
  }
}

/**
 * The note to show where a password or passphrase is typed, or null while
 * saved passwords survive restarts (or the status is unknown).
 */
export function credentialStoreHintKey(
  status: CredentialStoreStatus | null,
): CredentialHintKey | null {
  if (!status || status.persistent) return null;
  return status.reason === "portable"
    ? "session.secretsRunOnlyPortable"
    : "session.secretsRunOnlyNoKeyStore";
}
