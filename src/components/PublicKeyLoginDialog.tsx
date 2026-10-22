import { useRef, useState } from "react";

import * as api from "../api";
import { errorText } from "../errorInfo";
import type { Translate } from "../i18n";
import { open as openDialog } from "../nativeDialog";
import type { SessionProfile } from "../types";
import { useT } from "../useT";
import { Icon } from "./icons";
import { ModalDialog } from "./ModalDialog";

interface Props {
  /** The saved session the login belongs to; its id addresses the profile. */
  profile: SessionProfile;
  /** The live SSH session the install and the check run against. */
  sessionId: string;
  /**
   * Raised once the backend saved the new login. The caller adopts it on the
   * live tab's own profile copy, so a reconnect dials with the key.
   */
  onConfigured: (login: {
    privateKeyPath: string;
    passphrase: string | null;
  }) => void;
  onClose: () => void;
}

type Outcome =
  | { kind: "failed"; message: string }
  | { kind: "ran"; setup: api.KeySetup };

type Preview =
  | { kind: "ok"; summary: api.KeySummary }
  | { kind: "error"; message: string };

/**
 * What the last run means, in the user's words. The install and the check
 * are reported apart on purpose: a key that reached the server but was not
 * proven to log in must read as exactly that, not as a plain failure.
 */
function resultLine(t: Translate, setup: api.KeySetup): string {
  if (setup.saved) return t("keySetup.verifiedSaved");
  const state =
    setup.install.outcome === "added"
      ? t("keySetup.installedNotVerified")
      : setup.install.outcome === "present"
        ? t("keySetup.presentNotVerified")
        : t("keySetup.restrictedNotVerified", {
            options: setup.install.options ?? "",
          });
  return t("keySetup.notVerified", { state, reason: setup.check.message });
}

/**
 * One-click public-key login, opened from a saved session's menu: pick a
 * private key, install its public half into the server the session runs on,
 * and check on a fresh connection that the key alone logs in. The saved
 * session is only switched to the key once that check passed; the result
 * still reports an install that stopped there, so "installed but not
 * verified" is never mistaken for "nothing happened".
 */
export function PublicKeyLoginDialog({
  profile,
  sessionId,
  onConfigured,
  onClose,
}: Props) {
  const t = useT();
  const [keyPath, setKeyPath] = useState(profile.privateKeyPath ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const requestId = useRef<string | null>(null);
  /** Only the newest inspection may write; an earlier one can land later. */
  const previewSerial = useRef(0);
  /** The generate-a-key row, once the user opened it: the path to write. */
  const [generating, setGenerating] = useState<{ path: string } | null>(null);
  const [generateBusy, setGenerateBusy] = useState(false);

  const target = `${profile.username ?? ""}@${profile.host ?? ""}:${profile.port ?? 22}`;

  const inspect = async (path: string, pass: string) => {
    const serial = ++previewSerial.current;
    if (!path) {
      setPreview(null);
      return;
    }
    try {
      const summary = await api.inspectPrivateKey(path, pass || undefined);
      if (serial === previewSerial.current) setPreview({ kind: "ok", summary });
    } catch (error) {
      if (serial === previewSerial.current) {
        setPreview({ kind: "error", message: errorText(error) });
      }
    }
  };

  const browse = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        title: t("keySetup.pickKey"),
        defaultPath: keyPath.trim() || undefined,
      });
      if (typeof picked !== "string") return;
      setKeyPath(picked);
      setOutcome(null);
      await inspect(picked, passphrase);
    } catch (error) {
      setPreview({ kind: "error", message: errorText(error) });
    }
  };

  /**
   * Opens the generate row at the conventional default path. The home
   * directory is read only once the user asks for a new key, so opening the
   * dialog itself stays free of IPC.
   */
  const startGenerate = async () => {
    try {
      const home = await api.localHome();
      setGenerating({ path: `${home}/.ssh/id_ed25519` });
      setPreview(null);
      setOutcome(null);
    } catch (error) {
      setPreview({ kind: "error", message: errorText(error) });
    }
  };

  /**
   * Writes a brand-new key at the chosen path, encrypted with the dialog's
   * passphrase when one is set. The backend refuses to overwrite an existing
   * file; that refusal is reported like any other preview error and the row
   * stays open, so another path can be tried. On success the path lands in
   * the form and the new key's fingerprint becomes the preview.
   */
  const generate = async () => {
    const path = generating?.path.trim();
    if (!path || generateBusy) return;
    setGenerateBusy(true);
    try {
      const summary = await api.generatePrivateKey(path, passphrase);
      setKeyPath(path);
      setPreview({ kind: "ok", summary });
      setOutcome(null);
      setGenerating(null);
    } catch (error) {
      setPreview({ kind: "error", message: errorText(error) });
    } finally {
      setGenerateBusy(false);
    }
  };

  const run = async () => {
    const path = keyPath.trim();
    if (!path || busy) return;
    const id = api.newKeyCheckId();
    requestId.current = id;
    setBusy(true);
    setStopping(false);
    setOutcome(null);
    setPreview(null);
    try {
      const setup = await api.configurePublicKeyLogin(
        sessionId,
        id,
        profile.id,
        path,
        passphrase || null,
      );
      setOutcome({ kind: "ran", setup });
      if (setup.saved) {
        onConfigured({ privateKeyPath: path, passphrase: passphrase || null });
      }
    } catch (error) {
      setOutcome({ kind: "failed", message: errorText(error) });
    } finally {
      setBusy(false);
      setStopping(false);
      requestId.current = null;
    }
  };

  /**
   * A press while the setup runs asks the backend to stop the check — the
   * key may already be installed by then, so the dialog stays up to report
   * it. A key generation in flight closes nothing either: its result (the
   * path and the fingerprint) would be lost. Any other time the press
   * closes.
   */
  const cancel = () => {
    if (!busy && !generateBusy) {
      onClose();
      return;
    }
    if (requestId.current) {
      void api.cancelKeyCheck(requestId.current);
      setStopping(true);
    }
  };

  return (
    <ModalDialog
      open
      dismissable={false}
      contentClassName="key-setup-dialog"
      labelledBy="key-setup-title"
      title={t("keySetup.title")}
      onClose={cancel}
    >
      <div className="dialog-body key-setup-body">
        <p className="key-setup-intro">{t("keySetup.intro", { target })}</p>

        <label className="session-field is-wide">
          <span className="session-field-label">{t("keySetup.privateKey")}</span>
          <div className="key-setup-path">
            <input
              autoFocus
              value={keyPath}
              placeholder={t("keySetup.pathPlaceholder")}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              disabled={busy || generateBusy}
              onChange={(event) => {
                setKeyPath(event.target.value);
                setPreview(null);
                setOutcome(null);
              }}
              onBlur={() => void inspect(keyPath.trim(), passphrase)}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void browse()}
              disabled={busy || generateBusy}
            >
              {t("keySetup.browse")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void startGenerate()}
              disabled={busy || generating !== null}
            >
              {t("keySetup.generate")}
            </button>
          </div>
        </label>

        {/* Where a brand-new key is written: the path defaults to the
            conventional one, an existing file is never overwritten, and the
            passphrase above (when set) encrypts the new key. */}
        {generating && (
          <div className="session-field is-wide">
            <div className="key-setup-path">
              <input
                autoFocus
                value={generating.path}
                placeholder={t("keySetup.pathPlaceholder")}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                disabled={generateBusy}
                aria-label={t("keySetup.generatePathAria")}
                onChange={(event) => {
                  setGenerating({ path: event.target.value });
                  setPreview(null);
                }}
              />
              <button
                type="button"
                className="btn is-primary"
                onClick={() => void generate()}
                disabled={generateBusy || !generating.path.trim()}
              >
                {generateBusy
                  ? t("keySetup.generating")
                  : t("keySetup.generateRun")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setGenerating(null)}
                disabled={generateBusy}
              >
                {t("keySetup.cancel")}
              </button>
            </div>
            <span className="confirm-dialog-hint">
              {t("keySetup.generateHint")}
            </span>
          </div>
        )}

        <label className="session-field is-wide">
          <span className="session-field-label">{t("keySetup.passphrase")}</span>
          <div className="key-setup-field">
            <input
              type="password"
              value={passphrase}
              autoComplete="off"
              disabled={busy || generateBusy}
              onChange={(event) => {
                setPassphrase(event.target.value);
                setPreview(null);
              }}
              onBlur={() => void inspect(keyPath.trim(), passphrase)}
            />
            <span className="confirm-dialog-hint">
              {t("keySetup.passphraseHint")}
            </span>
          </div>
        </label>

        {preview?.kind === "ok" && (
          <div className="key-setup-result" role="status">
            <Icon name="key" />
            <span>
              {t("keySetup.preview", {
                type: preview.summary.keyType,
                fingerprint: preview.summary.fingerprint,
              })}
            </span>
          </div>
        )}
        {preview?.kind === "error" && (
          <div className="dialog-error session-dialog-error" role="alert">
            <Icon name="error" />
            <span>{preview.message}</span>
          </div>
        )}

        {outcome?.kind === "failed" && (
          <div className="dialog-error session-dialog-error" role="alert">
            <Icon name="error" />
            <span>{t("keySetup.failed", { message: outcome.message })}</span>
          </div>
        )}
        {outcome?.kind === "ran" && (
          <>
            <div
              className={`key-setup-result ${outcome.setup.saved ? "is-ok" : "is-warn"}`}
              role={outcome.setup.saved ? "status" : "alert"}
            >
              <Icon name={outcome.setup.saved ? "check" : "warning"} />
              <span>{resultLine(t, outcome.setup)}</span>
            </div>
            <div className="key-setup-entry">
              {t("keySetup.entry", { path: outcome.setup.install.path })}
            </div>
            {!outcome.setup.saved && (
              <div className="key-setup-entry is-plain">
                {t("keySetup.notSaved")}
              </div>
            )}
          </>
        )}
      </div>

      <div className="dialog-footer">
        <button
          type="button"
          className="btn"
          onClick={cancel}
          disabled={generateBusy}
        >
          {busy
            ? stopping
              ? t("keySetup.stopping")
              : t("keySetup.cancel")
            : t("keySetup.close")}
        </button>
        <button
          type="button"
          className="btn is-primary"
          onClick={() => void run()}
          disabled={busy || generateBusy || !keyPath.trim()}
        >
          <Icon name="key" />
          {busy ? t("keySetup.running") : t("keySetup.run")}
        </button>
      </div>
    </ModalDialog>
  );
}
