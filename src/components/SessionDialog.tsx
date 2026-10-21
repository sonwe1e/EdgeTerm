import { useEffect, useRef, useState, type CSSProperties } from "react";
import { errorText } from "../errorInfo";

import { openSession } from "../actions";
import * as api from "../api";
import {
  credentialStoreHint,
  fetchCredentialStoreStatus,
  type CredentialHint,
} from "../credentialStatus";
import {
  encodingLabel,
  DEFAULT_ENCODING,
  LOCALE_SUGGESTIONS,
  TERMINAL_ENCODINGS,
} from "../encodings";
import type { Translate } from "../i18n";
import { open as openDialog } from "../nativeDialog";
import { IS_WINDOWS } from "../platform";
import { validateProfile, invalidField, type InvalidSessionField } from "../sessionValidation";
import {
  flattenGroups,
  groupCategory,
  groupPath,
  sectionLabel,
} from "../sessionGroups";
import { useStore } from "../store";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

/** The pinned validation message, referenced by the offending field. */
const SESSION_ERROR_ID = "session-dialog-error";
import {
  colorForSession,
  isFileSession,
  isSshTransport,
  randomSessionColor,
  SESSION_COLORS,
  type BackspaceKey,
  type SerialPortDesc,
  type SessionKind,
  type SessionProfile,
} from "../types";
import { Icon, type IconName } from "./icons";

interface Props {
  initial: SessionProfile | null;
  onClose: () => void;
}

const BLANK: SessionProfile = {
  id: "",
  name: "",
  kind: "ssh",
  port: 22,
  auth: "password",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

const RAW_TEXT_INPUT = {
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

const defaultPort = (kind: SessionKind, current?: number | null) =>
  kind === "ssh" || kind === "sftp"
    ? (current ?? 22)
    : kind === "ftp"
      ? (current ?? 21)
      : kind === "telnet"
        ? (current ?? 23)
        : current;

/**
 * Protocol picker entries. FTP and SFTP share one "(S)FTP" choice, and SSH
 * and Telnet one "SSH / Telnet" choice, mirroring the Session panel's merged
 * sections; a sub-toggle inside the connection section picks the actual
 * protocol. `kinds[0]` is the default when the choice is selected fresh — the
 * encrypted one (SFTP, SSH). The icon and the one-word hint are what the
 * picker cards show under the name.
 */
const PROTOCOL_KINDS: { icon: IconName; kinds: SessionKind[] }[] = [
  { icon: "server", kinds: ["ssh", "telnet"] },
  { icon: "folder", kinds: ["sftp", "ftp"] },
  { icon: "terminal", kinds: ["local"] },
  { icon: "circuit-board", kinds: ["serial"] },
];

/** The picker icon of the choice a kind belongs to; also the dialog's badge. */
const protocolIcon = (kind: SessionKind): IconName =>
  PROTOCOL_KINDS.find((option) => option.kinds.includes(kind))?.icon ?? "server";

/** The picker cards, with their labels and hints in the current language. */
const protocolOptions = (
  t: Translate,
): { label: string; hint: string; icon: IconName; kinds: SessionKind[] }[] => [
  {
    label: t("protocol.sshTelnet.label"),
    hint: t("protocol.sshTelnet.hint"),
    icon: "server",
    kinds: ["ssh", "telnet"],
  },
  {
    label: t("protocol.sftp.label"),
    hint: t("protocol.sftp.hint"),
    icon: "folder",
    kinds: ["sftp", "ftp"],
  },
  {
    label: t("protocol.shell.label"),
    hint: t("protocol.shell.hint"),
    icon: "terminal",
    kinds: ["local"],
  },
  {
    label: t("protocol.serial.label"),
    hint: t("protocol.serial.hint"),
    icon: "circuit-board",
    kinds: ["serial"],
  },
];

/** How a kind is named in the header line, where the protocol is spelled out. */
const PROTOCOL_NAMES: Record<SessionKind, string> = {
  ssh: "SSH",
  telnet: "Telnet",
  sftp: "SFTP",
  ftp: "FTP",
  local: "Shell",
  serial: "Serial",
};

/** Column count of `.session-color-picker`; keep in sync with styles.css. */
const COLOR_PICKER_COLUMNS = 8;

const COMMON_BAUD_RATES = [
  1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400,
  460800, 500000, 576000, 921600, 1000000, 1500000, 2000000, 3000000,
  4000000,
];

/**
 * Saved SSH transports `profile` may be tunnelled through: every SSH / SFTP
 * profile except itself and those whose own jump chain already leads back to
 * it, which would loop. Mirrors the cycle check in the backend's
 * `Store::save`, so the menu never offers a choice that save would refuse.
 */
function jumpHostChoices(
  profile: SessionProfile,
  profiles: SessionProfile[],
): SessionProfile[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const leadsBackHere = (candidate: SessionProfile): boolean => {
    const seen = new Set<string>();
    let current: SessionProfile | undefined = candidate;
    while (current) {
      if (current.id === profile.id) return true;
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      current = current.jumpProfileId
        ? byId.get(current.jumpProfileId)
        : undefined;
    }
    return false;
  };
  return profiles.filter(
    (p) =>
      p.id &&
      p.id !== profile.id &&
      isSshTransport(p.kind) &&
      !(profile.id && leadsBackHere(p)),
  );
}

const describeJumpHost = (p: SessionProfile) =>
  `${p.name} — ${p.username ?? ""}@${p.host ?? ""}:${p.port ?? 22}`;

function nextColorIndex(
  key: string,
  current: number,
  count: number,
  columns: number,
): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "ArrowDown":
      return current + columns < count ? current + columns : current % columns;
    case "ArrowUp": {
      if (current - columns >= 0) return current - columns;
      const lastRowStart = Math.floor((count - 1) / columns) * columns;
      const target = lastRowStart + (current % columns);
      return target < count ? target : target - columns;
    }
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function SessionDialog({ initial, onClose }: Props) {
  const colorPickerRef = useRef<HTMLDivElement>(null);
  // The fields a failed Save/Connect can point at, so the caret lands where
  // the fix belongs instead of on the button that was just pressed.
  const fieldRefs = useRef<
    Partial<Record<InvalidSessionField | "name", HTMLElement | null>>
  >({});
  /** The field a validation message is about, marked while the message shows. */
  const invalidFieldRef = useRef<HTMLElement | null>(null);
  const focusField = (field: InvalidSessionField) => {
    const element = fieldRefs.current[field];
    if (!element) return;
    const previous = invalidFieldRef.current;
    if (previous && previous !== element) {
      previous.removeAttribute("aria-invalid");
      previous.removeAttribute("aria-describedby");
    }
    // The message is role="alert" and pinned above the buttons; pointing the
    // field at it makes the relationship explicit instead of relying on the
    // announcement alone.
    element.setAttribute("aria-invalid", "true");
    element.setAttribute("aria-describedby", SESSION_ERROR_ID);
    invalidFieldRef.current = element;
    element.focus();
  };
  const t = useT();
  const [profile, setProfile] = useState<SessionProfile>(() =>
    initial
      ? {
          ...initial,
          color:
            initial.color ?? colorForSession(initial.id || initial.name),
        }
      : { ...BLANK, color: randomSessionColor() },
  );
  const [ports, setPorts] = useState<SerialPortDesc[]>([]);
  // Where recordings go when the profile names no folder; the placeholder.
  const [defaultRecordDir, setDefaultRecordDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A field stays marked only while the message that explains it is shown.
  useEffect(() => {
    if (error || !invalidFieldRef.current) return;
    invalidFieldRef.current.removeAttribute("aria-invalid");
    invalidFieldRef.current.removeAttribute("aria-describedby");
    invalidFieldRef.current = null;
  }, [error]);
  const [busy, setBusy] = useState(false);
  // The note to show where a password is typed when it will not survive a
  // restart (portable mode, an unreachable OS credential store) or cannot be
  // saved at all (an unreadable stored file); null shows nothing.
  const [secretsHint, setSecretsHint] = useState<CredentialHint | null>(null);

  const upsertProfile = useStore((s) => s.upsertProfile);
  const groups = useStore((s) => s.groups);
  const profiles = useStore((s) => s.profiles);
  const groupChoices = flattenGroups(groups, profile.kind);
  const jumpChoices = jumpHostChoices(profile, profiles);
  // The chosen jump session was deleted (or now loops back here): keep it
  // visible so the user sees what is wrong; saving drops it.
  const jumpHostMissing =
    !!profile.jumpProfileId &&
    !jumpChoices.some((p) => p.id === profile.jumpProfileId);

  useEffect(() => {
    if (profile.kind !== "serial") return;
    api.listSerialPorts().then(setPorts).catch(() => setPorts([]));
  }, [profile.kind]);

  useEffect(() => {
    api.defaultRecordingDir().then(setDefaultRecordDir).catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetchCredentialStoreStatus().then((status) =>
      setSecretsHint(credentialStoreHint(status)),
    );
  }, []);

  const patch = (fields: Partial<SessionProfile>) => {
    setProfile((prev) => ({ ...prev, ...fields }));
    // The message described the attempt as it was; editing the form makes it
    // stale, and a stale error pinned above the buttons contradicts the values
    // the user is now looking at.
    setError(null);
  };

  const defaultName = () => {
    if (profile.kind === "ssh") return profile.host ?? "ssh";
    if (profile.kind === "telnet") return profile.host ?? "telnet";
    if (profile.kind === "sftp") return profile.host ?? "sftp";
    if (profile.kind === "ftp") return profile.host ?? "ftp";
    if (profile.kind === "serial") return profile.portName ?? "serial";
    return "shell";
  };

  const normalized = (): SessionProfile => ({
    ...profile,
    // Telnet has no authentication method of its own: a username and
    // password are typed at the server's prompts (issue #89), and the SSH
    // form's key settings are not kept. The store drops a password saved
    // under the other protocol when the protocol is switched.
    ...(profile.kind === "telnet"
      ? {
          username: profile.username?.trim() || null,
          auth: null,
          privateKeyPath: null,
          passphrase: null,
        }
      : {}),
    name: profile.name.trim() || defaultName(),
    // A jump host only means something on an SSH transport; drop one left
    // over from before the protocol was switched.
    jumpProfileId: isSshTransport(profile.kind)
      ? profile.jumpProfileId || null
      : null,
    // Encoding and locale belong to terminal sessions; UTF-8 and "automatic"
    // are stored as nothing, so an untouched profile stays as it was.
    encoding:
      !isFileSession(profile.kind) &&
      encodingLabel(profile.encoding) !== DEFAULT_ENCODING
        ? encodingLabel(profile.encoding)
        : null,
    // ^? is xterm's own and stored as nothing.
    backspace:
      !isFileSession(profile.kind) && profile.backspace === "controlH"
        ? "controlH"
        : null,
    locale:
      profile.kind === "local" || profile.kind === "ssh"
        ? profile.locale?.trim() || null
        : null,
    // Recording is a terminal thing and off unless the box was ticked; the
    // folder is kept while the box is off so ticking it again finds it.
    record: !isFileSession(profile.kind) && profile.record === true,
    recordDir: isFileSession(profile.kind)
      ? null
      : profile.recordDir?.trim() || null,
  });

  // One line under the title saying what the form connects to as it is filled
  // in, so the header always names the target rather than repeating the mode.
  const summary = (): string => {
    const name = PROTOCOL_NAMES[profile.kind];
    if (profile.kind === "local") {
      return `${name} · ${profile.shell?.trim() || (IS_WINDOWS ? "%COMSPEC%" : "$SHELL")}`;
    }
    if (profile.kind === "serial") {
      const port = profile.portName?.trim();
      return port
        ? `${name} · ${port} · ${profile.baudRate ?? 115200}${t("session.baud")}`
        : `${name} · ${t("session.noPort")}`;
    }
    const host = profile.host?.trim();
    if (!host) return `${name} · ${t("session.noHost")}`;
    const user = profile.username?.trim();
    return `${name} · ${user ? `${user}@` : ""}${host}:${profile.port ?? defaultPort(profile.kind)}`;
  };

  // What the session's bytes mean, for every terminal kind, and the locale
  // to ask the shell for — a local shell gets it as LANG, an SSH server is
  // asked for it; a serial device has no environment to hand it to.
  const renderTextFields = (withLocale: boolean) => {
    const encoding = encodingLabel(profile.encoding);
    const choices = TERMINAL_ENCODINGS.some((e) => e.label === encoding)
      ? TERMINAL_ENCODINGS
      : [...TERMINAL_ENCODINGS, { label: encoding, name: encoding }];
    return (
      <>
        <label className="session-field">
          <span className="session-field-label">{t("session.encoding")}</span>
          <select
            value={encoding}
            onChange={(event) => patch({ encoding: event.target.value })}
          >
            {choices.map((choice) => (
              <option key={choice.label} value={choice.label}>
                {choice.name}
              </option>
            ))}
          </select>
        </label>
        <label className="session-field">
          <span className="session-field-label">
            {t("session.backspaceSends")}
          </span>
          <select
            value={profile.backspace ?? "delete"}
            onChange={(event) =>
              patch({ backspace: event.target.value as BackspaceKey })
            }
          >
            <option value="delete">^? (DEL, 0x7f)</option>
            <option value="controlH">^H (BS, 0x08)</option>
          </select>
        </label>
        {withLocale && (
          <>
            <label className="session-field">
              <span className="session-field-label">{t("session.locale")}</span>
              <input
                {...RAW_TEXT_INPUT}
                list="session-locale-suggestions"
                data-field="locale"
                ref={(element) => { fieldRefs.current.locale = element; }}
                value={profile.locale ?? ""}
                placeholder={t("session.automatic")}
                onChange={(event) => patch({ locale: event.target.value })}
              />
              <datalist id="session-locale-suggestions">
                {LOCALE_SUGGESTIONS.map((locale) => (
                  <option key={locale} value={locale} />
                ))}
              </datalist>
            </label>
            <div className="session-note is-wide">
              <Icon name="info" />
              <span>
                {profile.kind === "ssh"
                  ? t("session.localeNoteSsh")
                  : t("session.localeNoteLocal")}
              </span>
            </div>
          </>
        )}
      </>
    );
  };

  const browseRecordDir = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("session.recordingFolderTitle"),
        defaultPath: profile.recordDir?.trim() || defaultRecordDir || undefined,
      });
      if (typeof picked === "string") patch({ recordDir: picked });
    } catch (e) {
      setError(errorText(e));
    }
  };

  // Session recording: off by default, one file per connection in the
  // profile's folder (or the app's default). Terminal kinds only — a file
  // session has no output stream to record.
  const renderRecordingSection = () => (
    <section className="session-section">
      <div className="session-section-heading">
        <Icon name="record" />
        <span>{t("session.recording")}</span>
        <small>{t("session.recordingHint")}</small>
      </div>
      <div className="session-form-grid">
        <label className="session-check is-wide">
          <input
            type="checkbox"
            checked={profile.record === true}
            onChange={(event) => patch({ record: event.target.checked })}
          />
          <span>{t("session.recordOutput")}</span>
        </label>
        {profile.record === true && (
          <>
            <div className="session-field is-wide">
              <label
                className="session-field-label"
                htmlFor="session-record-dir"
              >
                {t("session.folder")}
              </label>
              <div className="serial-port-row">
                <input
                  {...RAW_TEXT_INPUT}
                  id="session-record-dir"
                  value={profile.recordDir ?? ""}
                  placeholder={defaultRecordDir || t("session.defaultFolder")}
                  onChange={(event) => patch({ recordDir: event.target.value })}
                />
                <button
                  type="button"
                  className="btn serial-refresh"
                  onClick={() => void browseRecordDir()}
                  title={t("session.chooseFolder")}
                  aria-label={t("session.chooseFolder")}
                >
                  <Icon name="folder-opened" />
                </button>
              </div>
              <small className="session-field-hint">
                {t("session.recordNameHint", {
                  name: `${profile.name.trim() || defaultName()}_<date>_<time>.log`,
                })}
              </small>
            </div>
            <div className="session-note is-wide">
              <Icon name="info" />
              <span>{t("session.recordNote")}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );

  // ProxyJump: tunnel this session through another saved SSH session.
  // Offered for SSH and SFTP alike, since both ride the same transport.
  const renderJumpHostField = () => (
    <>
      <label className="session-field is-wide">
        <span className="session-field-label">{t("session.jumpHost")}</span>
        <select
          value={profile.jumpProfileId ?? ""}
          onChange={(event) =>
            patch({ jumpProfileId: event.target.value || null })
          }
        >
          <option value="">{t("session.jumpNone")}</option>
          {jumpHostMissing && (
            <option value={profile.jumpProfileId ?? ""}>
              {t("session.jumpDeleted")}
            </option>
          )}
          {jumpChoices.map((p) => (
            <option key={p.id} value={p.id}>
              {describeJumpHost(p)}
            </option>
          ))}
        </select>
      </label>
      <div className="session-note is-wide">
        <Icon name="info" />
        <span>{t("session.jumpNote")}</span>
      </div>
    </>
  );

  // One note, wherever a password or passphrase is typed, when it will not be
  // kept across restarts; a warning when saving is refused outright.
  const renderSecretsHint = () =>
    secretsHint ? (
      <div
        className={`session-note is-wide${secretsHint.warning ? " is-warning" : ""}`}
      >
        <Icon name={secretsHint.warning ? "warning" : "info"} />
        <span>{t(secretsHint.key)}</span>
      </div>
    ) : null;

  // The authentication block shared by SSH and SFTP: they ride the same
  // transport, so both offer password, public-key, and ssh-agent auth with the
  // exact same inputs.
  const renderServerAuthFields = () => (
    <>
      <label className="session-field">
        <span className="session-field-label">
          {t("session.authentication")}
        </span>
        <select
          value={profile.auth ?? "password"}
          onChange={(event) =>
            patch({ auth: event.target.value as SessionProfile["auth"] })
          }
        >
          <option value="password">{t("session.authPassword")}</option>
          <option value="publicKey">{t("session.authPublicKey")}</option>
          <option value="agent">{t("session.authAgent")}</option>
        </select>
      </label>

      {profile.auth === "password" && (
        <>
          <label className="session-field is-wide">
            <span className="session-field-label">{t("session.password")}</span>
            <input
              {...RAW_TEXT_INPUT}
              type="password"
              value={profile.password ?? ""}
              // Left empty, the password is asked for at each connection
              // (issue #88). Only a new session can say so: a saved password
              // never reaches this dialog, so an existing one's empty field
              // may hold one.
              placeholder={initial?.id ? undefined : t("session.askOnConnect")}
              onChange={(event) => patch({ password: event.target.value })}
            />
          </label>
          {renderSecretsHint()}
        </>
      )}

      {profile.auth === "publicKey" && (
        <>
          <label className="session-field is-wide">
            <span className="session-field-label">
              {t("session.privateKey")}
            </span>
            <input
              {...RAW_TEXT_INPUT}
              value={profile.privateKeyPath ?? ""}
              placeholder="~/.ssh/id_ed25519"
              onChange={(event) => patch({ privateKeyPath: event.target.value })}
            />
          </label>
          <label className="session-field is-wide">
            <span className="session-field-label">
              {t("session.passphrase")}
            </span>
            <input
              {...RAW_TEXT_INPUT}
              type="password"
              value={profile.passphrase ?? ""}
              onChange={(event) => patch({ passphrase: event.target.value })}
            />
          </label>
          {renderSecretsHint()}
        </>
      )}
    </>
  );

  const save = async () => {
    const candidate = normalized();
    const validationError = validateProfile(candidate);
    if (validationError) {
      setError(validationError);
      // Put the caret on the field the message is about; the error itself is
      // pinned above the buttons so it is visible wherever the body scrolled.
      const field = invalidField(candidate);
      if (field) focusField(field);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await upsertProfile(candidate);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const candidate = normalized();
    const validationError = validateProfile(candidate);
    if (validationError) {
      setError(validationError);
      // Put the caret on the field the message is about; the error itself is
      // pinned above the buttons so it is visible wherever the body scrolled.
      const field = invalidField(candidate);
      if (field) focusField(field);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Saving first keeps the profile in the tree and stores its credentials
      // in the operating system's secure credential vault. A one-off local
      // shell is the exception: the tree already has its built-in row, and
      // saving "shell" on every Connect left a pile of identical profiles.
      const quickLocal = candidate.kind === "local" && !initial?.id;
      const saved = candidate.name && !quickLocal
        ? await upsertProfile(candidate)
        : candidate;
      const id = await openSession({
        ...saved,
        password: candidate.password,
        passphrase: candidate.passphrase,
      });
      if (id) onClose();
      else setError(useStore.getState().error ?? t("session.connectionFailed"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const selectedPort = ports.find(
    (port) => port.portName === profile.portName,
  );
  const parityCode =
    profile.parity === "odd" ? "O" : profile.parity === "even" ? "E" : "N";

  return (
    <ModalDialog open onClose={onClose} dismissable={false} draggable
      contentClassName="session-dialog" headerClassName="session-dialog-header"
      initialFocus={
        profile.kind === "local" || profile.kind === "serial"
          ? '[data-field="name"]'
          : '[data-field="host"]'
      }
      labelledBy="session-dialog-title" title={<>
          {/* The badge carries the session colour picked below, so the
              dialog wears the identity the tab will have. */}
          <span
            className="session-dialog-badge"
            style={
              {
                "--session-color": profile.color ?? "var(--accent)",
              } as CSSProperties
            }
            aria-hidden="true"
          >
            <Icon name={protocolIcon(profile.kind)} />
          </span>
          <div className="session-dialog-heading">
            <div className="session-dialog-title">
              {initial?.id ? t("session.editTitle") : t("session.newTitle")}
            </div>
            <div className="session-dialog-subtitle">{summary()}</div>
          </div>
          <button
            className="panel-action"
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="close" />
          </button>
      </>}>

        <div className="dialog-body session-dialog-body">
          <section className="session-section">
            <div className="session-section-heading">
              <Icon name="tag" />
              <span>{t("session.sectionSession")}</span>
              <small>{t("session.identityHint")}</small>
            </div>
            <div className="session-form-grid">
              <div className="session-field is-wide">
                <span className="session-field-label">
                  {t("session.protocol")}
                </span>
                <div
                  className="protocol-picker"
                  role="radiogroup"
                  aria-label={t("session.protocol")}
                >
                  {protocolOptions(t).map((option) => {
                    const active = option.kinds.includes(profile.kind);
                    // Keep the current sub-choice when the group already
                    // matches; otherwise select the option's default kind.
                    const target = active ? profile.kind : option.kinds[0];
                    return (
                      <button
                        key={option.kinds[0]}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`protocol-option${active ? " is-active" : ""}`}
                        onClick={() =>
                          patch({
                            kind: target,
                            port: defaultPort(
                              target,
                              profile.kind === target ? profile.port : null,
                            ),
                            // Groups belong to one category; FTP and SFTP share
                            // theirs, so the choice survives switching between
                            // them but is cleared across categories.
                            groupId:
                              groupCategory(profile.kind) ===
                              groupCategory(target)
                                ? profile.groupId
                                : null,
                          })
                        }
                      >
                        <span className="protocol-option-icon">
                          <Icon name={option.icon} />
                        </span>
                        <span className="protocol-option-label">
                          {option.label}
                        </span>
                        <small className="protocol-option-hint">
                          {option.hint}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="session-field">
                <span className="session-field-label">{t("session.name")}</span>
                <input
                  {...RAW_TEXT_INPUT}
                  data-field="name"
                  ref={(element) => { fieldRefs.current.name = element; }}
                  value={profile.name}
                  placeholder={defaultName()}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </label>

              <div className="session-field">
                <span className="session-field-label">{t("session.color")}</span>
                <div
                  ref={colorPickerRef}
                  className="session-color-picker"
                  role="radiogroup"
                  aria-label={t("session.sessionColor")}
                  onKeyDown={(event) => {
                    const current = SESSION_COLORS.indexOf(
                      (event.target as HTMLElement).dataset.color ?? "",
                    );
                    if (current < 0) return;
                    const next = nextColorIndex(
                      event.key,
                      current,
                      SESSION_COLORS.length,
                      COLOR_PICKER_COLUMNS,
                    );
                    if (next == null) return;
                    event.preventDefault();
                    const color = SESSION_COLORS[next];
                    patch({ color });
                    colorPickerRef.current
                      ?.querySelector<HTMLButtonElement>(
                        `[data-color="${color}"]`,
                      )
                      ?.focus();
                  }}
                >
                  {SESSION_COLORS.map((color, index) => {
                    const selected = profile.color === color;
                    // Roving tabindex: only the selected swatch is a Tab stop,
                    // so Tab moves on to the next field and arrow keys pick colors.
                    const tabbable =
                      selected ||
                      (!SESSION_COLORS.includes(profile.color ?? "") &&
                        index === 0);
                    return (
                      <button
                        key={color}
                        type="button"
                        role="radio"
                        data-color={color}
                        tabIndex={tabbable ? 0 : -1}
                        className={`session-color-option${selected ? " is-selected" : ""}`}
                        style={{ background: color }}
                        aria-checked={selected}
                        aria-label={t("session.useColor", { color })}
                        title={color}
                        onClick={() => patch({ color })}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="session-field is-wide">
                <label className="session-field-label" htmlFor="session-group">
                  {t("session.group")}
                </label>
                <select
                  id="session-group"
                  value={profile.groupId ?? ""}
                  onChange={(event) =>
                    patch({ groupId: event.target.value || null })
                  }
                >
                  <option value="">
                    {t("session.noGroup", { section: sectionLabel(profile.kind, t) })}
                  </option>
                  {groupChoices.map(({ group }) => (
                    <option key={group.id} value={group.id}>
                      {groupPath(groups, group.id).join(" / ")}
                    </option>
                  ))}
                </select>
                {groupChoices.length === 0 && (
                  <small className="session-field-hint">
                    {t("session.groupHint")}
                  </small>
                )}
              </div>
            </div>
          </section>

          {(profile.kind === "ssh" || profile.kind === "telnet") && (
            <section className="session-section">
              <div className="session-section-heading">
                <Icon name="server" />
                <span>
                  {profile.kind === "ssh"
                    ? t("session.sshConnection")
                    : t("session.telnetConnection")}
                </span>
                <small>
                  {profile.kind === "ssh"
                    ? t("session.serverAndAuth")
                    : t("session.telnetSubtitle")}
                </small>
              </div>
              <div className="session-form-grid">
                <div className="session-field is-wide">
                  <span className="session-field-label">
                    {t("session.protocol")}
                  </span>
                  <div className="kind-picker">
                    {(["ssh", "telnet"] as SessionKind[]).map((sub) => (
                      <button
                        key={sub}
                        className={`kind-option${profile.kind === sub ? " is-active" : ""}`}
                        onClick={() =>
                          patch({
                            kind: sub,
                            // Swap the default port when it is still the old
                            // default; keep a custom port untouched. The group
                            // survives — SSH and Telnet share one category.
                            port:
                              profile.port === defaultPort(profile.kind)
                                ? defaultPort(sub)
                                : profile.port,
                          })
                        }
                      >
                        {sub === "ssh" ? "SSH" : "Telnet"}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="session-field">
                  <span className="session-field-label">{t("session.host")}</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    data-field="host"
                    ref={(element) => { fieldRefs.current.host = element; }}
                    value={profile.host ?? ""}
                    placeholder={
                      profile.kind === "ssh" ? "example.com" : "192.168.1.1"
                    }
                    onChange={(event) => patch({ host: event.target.value })}
                  />
                </label>

                <label className="session-field">
                  <span className="session-field-label">{t("session.port")}</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    data-field="port"
                    ref={(element) => { fieldRefs.current.port = element; }}
                    value={profile.port ?? (profile.kind === "ssh" ? 22 : 23)}
                    onChange={(event) =>
                      patch({
                        port:
                          Number(event.target.value) ||
                          (profile.kind === "ssh" ? 22 : 23),
                      })
                    }
                  />
                </label>

                {profile.kind === "ssh" ? (
                  <>
                    <label className="session-field">
                      <span className="session-field-label">{t("session.username")}</span>
                      <input
                        {...RAW_TEXT_INPUT}
                        value={profile.username ?? ""}
                        placeholder="user"
                        onChange={(event) =>
                          patch({ username: event.target.value })
                        }
                      />
                    </label>

                    {renderServerAuthFields()}
                    {renderJumpHostField()}
                    {renderTextFields(true)}
                  </>
                ) : (
                  <>
                    <label className="session-field">
                      <span className="session-field-label">{t("session.username")}</span>
                      <input
                        {...RAW_TEXT_INPUT}
                        value={profile.username ?? ""}
                        placeholder={t("session.optional")}
                        onChange={(event) =>
                          patch({ username: event.target.value })
                        }
                      />
                    </label>
                    <label className="session-field">
                      <span className="session-field-label">{t("session.password")}</span>
                      <input
                        {...RAW_TEXT_INPUT}
                        type="password"
                        value={profile.password ?? ""}
                        // As for SSH, a saved password never reaches this
                        // dialog, so only a new session can say "optional".
                        placeholder={
                          initial?.id ? undefined : t("session.optional")
                        }
                        onChange={(event) =>
                          patch({ password: event.target.value })
                        }
                      />
                    </label>
                    {renderSecretsHint()}
                    <div className="session-note is-wide">
                      <Icon name="info" />
                      <span>{t("session.telnetLoginNote")}</span>
                    </div>
                    {renderTextFields(false)}
                    <div className="session-note is-wide">
                      <Icon name="info" />
                      <span>{t("session.telnetPortNote")}</span>
                    </div>
                    <div className="session-note is-warning is-wide">
                      <Icon name="warning" />
                      <span>{t("session.telnetWarning")}</span>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {(profile.kind === "sftp" || profile.kind === "ftp") && (
            <section className="session-section">
              <div className="session-section-heading">
                <Icon name="folder" />
                <span>{t("session.sftpConnection")}</span>
                <small>
                  {profile.kind === "sftp"
                    ? t("session.sftpSubtitle")
                    : t("session.ftpSubtitle")}
                </small>
              </div>
              <div className="session-form-grid">
                <div className="session-field is-wide">
                  <span className="session-field-label">
                    {t("session.protocol")}
                  </span>
                  <div className="kind-picker">
                    {(["sftp", "ftp"] as SessionKind[]).map((sub) => (
                      <button
                        key={sub}
                        className={`kind-option${profile.kind === sub ? " is-active" : ""}`}
                        onClick={() =>
                          patch({
                            kind: sub,
                            // Swap the default port when it is still the old
                            // default; keep a custom port untouched. The group
                            // survives — FTP and SFTP share one category.
                            port:
                              profile.port === defaultPort(profile.kind)
                                ? defaultPort(sub)
                                : profile.port,
                          })
                        }
                      >
                        {sub === "sftp"
                          ? t("session.sftpOverSsh")
                          : t("session.ftp")}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="session-field">
                  <span className="session-field-label">{t("session.host")}</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    data-field="host"
                    ref={(element) => { fieldRefs.current.host = element; }}
                    value={profile.host ?? ""}
                    placeholder={
                      profile.kind === "sftp"
                        ? "sftp.example.com"
                        : "ftp.example.com"
                    }
                    onChange={(event) => patch({ host: event.target.value })}
                  />
                </label>

                <label className="session-field">
                  <span className="session-field-label">{t("session.port")}</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={profile.port ?? (profile.kind === "sftp" ? 22 : 21)}
                    onChange={(event) =>
                      patch({
                        port:
                          Number(event.target.value) ||
                          (profile.kind === "sftp" ? 22 : 21),
                      })
                    }
                  />
                </label>

                <label className="session-field">
                  <span className="session-field-label">{t("session.username")}</span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.username ?? ""}
                    placeholder={profile.kind === "sftp" ? "user" : "anonymous"}
                    onChange={(event) => patch({ username: event.target.value })}
                  />
                </label>

                {profile.kind === "sftp" ? (
                  <>
                    {renderServerAuthFields()}
                    {renderJumpHostField()}
                  </>
                ) : (
                  <>
                    <label className="session-field">
                      <span className="session-field-label">{t("session.password")}</span>
                      <input
                        {...RAW_TEXT_INPUT}
                        type="password"
                        value={profile.password ?? ""}
                        placeholder={t("session.optionalAnonFtp")}
                        onChange={(event) =>
                          patch({ password: event.target.value })
                        }
                      />
                    </label>
                    {renderSecretsHint()}

                    <div className="session-note is-warning is-wide">
                      <Icon name="warning" />
                      <span>{t("session.ftpWarning")}</span>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {profile.kind === "local" && (
            <section className="session-section">
              <div className="session-section-heading">
                <Icon name="terminal" />
                <span>{t("session.localShell")}</span>
                <small>{t("session.processAndCwd")}</small>
              </div>
              <div className="session-form-grid">
                <label className="session-field is-wide">
                  <span className="session-field-label">
                    {t("session.shell")}
                  </span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.shell ?? ""}
                    placeholder={IS_WINDOWS ? "%COMSPEC%" : "$SHELL"}
                    onChange={(event) => patch({ shell: event.target.value })}
                  />
                </label>
                <label className="session-field is-wide">
                  <span className="session-field-label">
                    {t("session.directory")}
                  </span>
                  <input
                    {...RAW_TEXT_INPUT}
                    value={profile.cwd ?? ""}
                    placeholder={t("session.homeDirectory")}
                    onChange={(event) => patch({ cwd: event.target.value })}
                  />
                </label>
                {renderTextFields(true)}
              </div>
            </section>
          )}

          {profile.kind === "serial" && (
            <section className="session-section">
              <div className="session-section-heading">
                <Icon name="circuit-board" />
                <span>{t("session.serialConnection")}</span>
                <small>
                  {profile.dataBits ?? 8}-{parityCode}-{profile.stopBits ?? 1}
                  {profile.flowControl && profile.flowControl !== "none"
                    ? ` · ${
                        profile.flowControl === "software"
                          ? t("session.flowWordSoftware")
                          : t("session.flowWordHardware")
                      } ${t("session.flowControl")}`
                    : t("session.noFlowControl")}
                </small>
              </div>
              <div className="session-form-grid">
                <div className="session-field is-wide">
                  <span className="session-field-label">
                    {t("session.port")}
                  </span>
                  <div className="serial-port-row">
                    <select
                      value={profile.portName ?? ""}
                      aria-label={t("session.port")}
                      onChange={(event) =>
                        patch({ portName: event.target.value })
                      }
                    >
                      <option value="">{t("session.selectPort")}</option>
                      {ports.map((port) => (
                        <option key={port.portName} value={port.portName}>
                          {port.portName}
                          {port.description ? ` — ${port.description}` : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn serial-refresh"
                      onClick={() =>
                        api
                          .listSerialPorts()
                          .then(setPorts)
                          .catch(() => undefined)
                      }
                      title={t("session.refreshPorts")}
                      aria-label={t("session.refreshPorts")}
                    >
                      <Icon name="refresh" />
                    </button>
                  </div>
                  <small className="session-field-hint">
                    {selectedPort?.description ||
                      (ports.length
                        ? t("session.portHintDetected")
                        : t("session.portHintNone"))}
                  </small>
                </div>

                <div className="session-field is-wide">
                  <label
                    className="session-field-label"
                    htmlFor="serial-baud-rate"
                  >
                    {t("session.baudRate")}
                  </label>
                  <div className="input-with-suffix">
                    <input
                      id="serial-baud-rate"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={0xffffffff}
                      step={1}
                      list="serial-baud-rates"
                      data-field="baudRate"
                      ref={(element) => { fieldRefs.current.baudRate = element; }}
                      value={profile.baudRate ?? ""}
                      placeholder="115200"
                      onChange={(event) =>
                        patch({
                          baudRate:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        })
                      }
                    />
                    <span>{t("session.baudUnit")}</span>
                  </div>
                  <datalist id="serial-baud-rates">
                    {COMMON_BAUD_RATES.map((rate) => (
                      <option key={rate} value={rate} />
                    ))}
                  </datalist>
                  <small className="session-field-hint">
                    {t("session.baudHint")}
                  </small>
                </div>

                <label className="session-field">
                  <span className="session-field-label">
                    {t("session.dataBits")}
                  </span>
                  <select
                    value={profile.dataBits ?? 8}
                    onChange={(event) =>
                      patch({ dataBits: Number(event.target.value) })
                    }
                  >
                    {[5, 6, 7, 8].map((bits) => (
                      <option key={bits} value={bits}>
                        {t("session.bitsCount", { count: bits })}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="session-field">
                  <span className="session-field-label">
                    {t("session.stopBits")}
                  </span>
                  <select
                    value={profile.stopBits ?? 1}
                    onChange={(event) =>
                      patch({ stopBits: Number(event.target.value) })
                    }
                  >
                    <option value={1}>{t("session.stopBitOne")}</option>
                    <option value={2}>{t("session.stopBitTwo")}</option>
                  </select>
                </label>

                <label className="session-field">
                  <span className="session-field-label">
                    {t("session.parity")}
                  </span>
                  <select
                    value={profile.parity ?? "none"}
                    onChange={(event) => patch({ parity: event.target.value })}
                  >
                    <option value="none">{t("session.parityNone")}</option>
                    <option value="odd">{t("session.parityOdd")}</option>
                    <option value="even">{t("session.parityEven")}</option>
                  </select>
                </label>

                <label className="session-field">
                  <span className="session-field-label">
                    {t("session.flowControlField")}
                  </span>
                  <select
                    value={profile.flowControl ?? "none"}
                    onChange={(event) =>
                      patch({ flowControl: event.target.value })
                    }
                  >
                    <option value="none">{t("session.flowNone")}</option>
                    <option value="software">
                      {t("session.flowSoftware")}
                    </option>
                    <option value="hardware">
                      {t("session.flowHardware")}
                    </option>
                  </select>
                </label>
                {renderTextFields(false)}
              </div>
            </section>
          )}

          {!isFileSession(profile.kind) && renderRecordingSection()}

        </div>

        {/* Outside the scrolling body: a failed Connect must be visible even
            when the form is scrolled to the top. */}
        {error && (
          <div
            className="dialog-error session-dialog-error"
            id={SESSION_ERROR_ID}
            role="alert"
          >
            <Icon name="error" />
            <span>{error}</span>
          </div>
        )}

        <div className="dialog-footer">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn" onClick={save} disabled={busy}>
            <Icon name="save" />
            {t("common.save")}
          </button>
          <button
            type="button"
            className={`btn is-primary${busy ? " is-loading" : ""}`}
            onClick={connect}
            disabled={busy}
          >
            <Icon name="plug" />
            {busy ? t("session.connecting") : t("session.connect")}
          </button>
        </div>
    </ModalDialog>
  );
}
