import { LOCALE_NAME } from "./encodings";
import { t } from "./i18n";
import type { SessionProfile } from "./types";

/**
 * What must be true before a session can be saved or dialled. Kept apart from
 * the dialog so the rules are testable without mounting the largest form in
 * the app.
 *
 * A remote transport without a host used to pass: Connect then saved a
 * profile named after the empty host and opened a tab that failed, leaving a
 * dead entry in the tree. Ports outside 1–65535 are rejected for the same
 * reason — the backend would refuse them after the same round trip.
 */
export type InvalidSessionField = "locale" | "baudRate" | "host" | "port";

/**
 * The first field that blocks Save/Connect. The dialog uses the field name to
 * put the caret where the fix belongs; `validateProfile` turns the same answer
 * into the message shown to the user, so the two cannot drift.
 */
export function invalidField(
  profile: SessionProfile,
): InvalidSessionField | null {
  if (profile.locale && !LOCALE_NAME.test(profile.locale)) {
    return "locale";
  }
  if (profile.kind === "serial") {
    const baudRate = profile.baudRate;
    if (
      baudRate == null ||
      !Number.isInteger(baudRate) ||
      baudRate <= 0 ||
      baudRate > 0xffffffff
    ) {
      return "baudRate";
    }
    return null;
  }
  if (profile.kind === "local") return null;

  if (!profile.host?.trim()) return "host";
  const port = profile.port;
  if (
    port != null &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    return "port";
  }
  return null;
}

export function validateProfile(profile: SessionProfile): string | null {
  switch (invalidField(profile)) {
    case "locale":
      return t("session.localeError");
    case "baudRate":
      return t("session.baudError");
    case "host":
      return t("session.hostRequired");
    case "port":
      return t("session.portError");
    default:
      return null;
  }
}
