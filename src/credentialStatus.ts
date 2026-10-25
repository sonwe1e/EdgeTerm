import { commands, type CredentialStoreStatus } from "./bindings";
import type { MessageKey } from "./i18n";

// How the backend protects saved passwords right now (`credential_store_status`).
// The session editor asks once per open and notes the answer where a password
// is typed, so a password that is not kept across restarts — or refused
// outright because the stored file cannot be read — is not a surprise.

export type CredentialHintKey = Extract<
  MessageKey,
  | "session.secretsRunOnlyPortable"
  | "session.secretsRunOnlyNoKeyStore"
  | "session.secretsUnreadable"
>;

/** The note for where a password is typed, and how loudly to show it. */
export interface CredentialHint {
  key: CredentialHintKey;
  /** True for a problem the user must fix before a password can be saved. */
  warning: boolean;
}

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
 * saved passwords survive restarts (or the status is unknown). An unreadable
 * vault file is a warning: saving a password is refused so the file survives
 * for recovery.
 */
export function credentialStoreHint(status: CredentialStoreStatus | null): CredentialHint | null {
  if (!status || status.persistent) return null;
  switch (status.reason) {
    case "portable":
      return { key: "session.secretsRunOnlyPortable", warning: false };
    case "keyStoreUnavailable":
      return { key: "session.secretsRunOnlyNoKeyStore", warning: false };
    case "credentialsUnreadable":
      return { key: "session.secretsUnreadable", warning: true };
    default:
      return null;
  }
}
