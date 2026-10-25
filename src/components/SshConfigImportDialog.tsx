import { useMemo, useState } from "react";
import { errorText } from "../errorInfo";

import * as api from "../api";
import { t as translateMsg, type MessageKey } from "../i18n";
import { groupPath } from "../sessionGroups";
import { useStore } from "../store";
import type { SshConfigEntry, SshConfigPreview } from "../types";
import { Icon } from "./icons";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  preview: SshConfigPreview;
  onClose: () => void;
}

const basename = (path: string) => path.split(/[\\/]/).pop() || path;

/** `user@host`, with the port when it is not the default. */
const target = (entry: SshConfigEntry) =>
  `${entry.username}@${entry.host}${entry.port === 22 ? "" : `:${entry.port}`}`;

function authLabel(entry: SshConfigEntry): string {
  if (entry.auth === "publicKey" && entry.privateKeyPath) {
    return translateMsg("sshImport.authKey", {
      name: basename(entry.privateKeyPath),
    });
  }
  return entry.auth === "agent"
    ? translateMsg("sshImport.authAgent")
    : translateMsg("sshImport.authPassword");
}

/** The one-letter badge of a forward's direction, the way `ssh -L/-R/-D` writes it. */
const FORWARD_LETTER: Record<api.PortForwardSpec["direction"], MessageKey> = {
  local: "forward.letterLocal",
  remote: "forward.letterRemote",
  dynamic: "forward.letterDynamic",
};

/** `host:port`, bracketing an IPv6 literal; port 0 reads as "automatic". */
const endpoint = (host: string, port: number, auto: string) =>
  `${host.includes(":") ? `[${host}]` : host}:${port || auto}`;

/** One forward as `listen → target`; a dynamic (SOCKS5) forward names no target. */
const forwardRoute = (spec: api.PortForwardSpec, auto: string) => {
  const listen = endpoint(spec.listenHost, spec.listenPort, auto);
  if (spec.direction === "dynamic") return listen;
  const host = spec.targetHost ?? "";
  return `${listen} → ${host ? endpoint(host, spec.targetPort ?? 0, auto) : ""}`;
};

/**
 * Chooser for Session → Import OpenSSH Config…: the `Host` aliases of the
 * picked file, each with what `ssh alias` would connect to. Aliases the
 * store already knows start unchecked, since importing one rewrites the
 * saved session's target from the file. Like every dialog holding choices
 * it only closes through its buttons; a click outside makes it blink.
 */
export function SshConfigImportDialog({ preview, onClose }: Props) {
  const t = useT();
  const groups = useStore((s) => s.groups);
  const setStatus = useStore((s) => s.setStatus);
  const loadProfiles = useStore((s) => s.loadProfiles);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preview.entries.filter((entry) => !entry.existingId).map((entry) => entry.alias)),
  );
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sshGroups = useMemo(
    () =>
      groups
        .filter((group) => group.kind === "ssh")
        .map((group) => ({
          id: group.id,
          label: groupPath(groups, group.id).join(" / "),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [groups],
  );

  const toggle = (alias: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  const allSelected = selected.size === preview.entries.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(preview.entries.map((entry) => entry.alias)));
  // How many forwards the current selection carries. The backend's summary
  // counts sessions and jump hosts only, so the import reports this one from
  // the selection itself; the import writes each chosen entry's forwards
  // verbatim, so the number is what will start on the next connect.
  const selectedForwards = preview.entries
    .filter((entry) => selected.has(entry.alias))
    .reduce((total, entry) => total + (entry.forwards?.length ?? 0), 0);

  const submit = async () => {
    if (selected.size === 0) {
      setError(t("sshImport.chooseAtLeastOne"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const aliases = preview.entries
        .filter((entry) => selected.has(entry.alias))
        .map((entry) => entry.alias);
      const summary = await api.importSshConfig(preview.path, aliases, groupId || null);
      await loadProfiles();
      const parts: string[] = [];
      if (summary.added > 0) {
        parts.push(
          summary.added === 1
            ? t("sshImport.addedOne")
            : t("sshImport.addedMany", { count: summary.added }),
        );
      }
      if (summary.updated > 0) {
        parts.push(
          summary.updated === 1
            ? t("sshImport.updatedOne")
            : t("sshImport.updatedMany", { count: summary.updated }),
        );
      }
      if (summary.jumpHosts > 0) {
        parts.push(
          summary.jumpHosts === 1
            ? t("sshImport.jumpHostsAddedOne")
            : t("sshImport.jumpHostsAddedMany", { count: summary.jumpHosts }),
        );
      }
      // The backend reports sessions and jump hosts but not forwards, so the
      // count comes from the selection itself (see selectedForwards).
      const forwards = selectedForwards;
      if (forwards > 0) {
        parts.push(
          forwards === 1
            ? t("sshImport.forwardsImportedOne")
            : t("sshImport.forwardsImportedMany", { count: forwards }),
        );
      }
      if (summary.jumpsIgnored > 0) {
        parts.push(
          summary.jumpsIgnored === 1
            ? t("sshImport.jumpsIgnoredOne")
            : t("sshImport.jumpsIgnoredMany", { count: summary.jumpsIgnored }),
        );
      }
      let status = t("sshImport.importedFrom", {
        name: basename(preview.path),
        parts: parts.join(", ") || t("sshImport.nothingToDo"),
      });
      if (summary.warnings.length > 0) {
        status += `; ${summary.warnings.join("; ")}`;
      }
      setStatus(status);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open
      labelledBy="ssh-import-title"
      contentClassName="ssh-import-dialog"
      onClose={onClose}
      dismissable={false}
    >
      <div className="dialog-header">
        <span id="ssh-import-title">{t("sshImport.title")}</span>
        <button
          className="panel-action"
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog-body ssh-import-body">
        <span className="confirm-dialog-target">{preview.path}</span>
        <div className="ssh-import-list" role="group" aria-label={t("sshImport.hostsGroup")}>
          <label className="ssh-import-row is-head has-forwards">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label={t("sshImport.selectAllHosts")}
            />
            <span className="ssh-import-alias">{t("sshImport.hostColumn")}</span>
            <span className="ssh-import-target">{t("sshImport.connectsToColumn")}</span>
            <span className="ssh-import-note">{t("sshImport.authColumn")}</span>
            <span className="ssh-import-forwards">{t("sshImport.forwardsColumn")}</span>
          </label>
          {preview.entries.map((entry) => (
            <label
              key={entry.alias}
              className={`ssh-import-row has-forwards${entry.existingId ? " is-existing" : ""}`}
            >
              <input
                type="checkbox"
                checked={selected.has(entry.alias)}
                onChange={() => toggle(entry.alias)}
              />
              <span className="ssh-import-alias" title={entry.alias}>
                {entry.alias}
              </span>
              <span className="ssh-import-target" title={target(entry)}>
                {target(entry)}
                {entry.jumps.length === 1 && (
                  <span className="ssh-import-via">
                    {t("sshImport.viaJump", { jump: entry.jumps[0] })}
                  </span>
                )}
                {entry.jumps.length > 1 && (
                  <span className="ssh-import-via">
                    {" "}
                    {t("sshImport.viaMultiHop", { jumps: entry.jumps.join(", ") })}
                  </span>
                )}
              </span>
              <span className="ssh-import-note">
                <span title={entry.privateKeyPath ?? undefined}>{authLabel(entry)}</span>
                {entry.existingId && (
                  <span className="ssh-import-existing">
                    {t("sshImport.updates", { name: entry.existingName ?? "" })}
                  </span>
                )}
              </span>
              <span className="ssh-import-forwards">
                {(entry.forwards ?? []).length === 0 ? (
                  <span className="ssh-import-forward">—</span>
                ) : (
                  entry.forwards?.map((spec, index) => (
                    <span
                      key={index}
                      className="ssh-import-forward"
                      title={`${t(FORWARD_LETTER[spec.direction])} ${forwardRoute(spec, t("forward.autoPort"))}`}
                    >
                      <b>{t(FORWARD_LETTER[spec.direction])}</b>{" "}
                      {forwardRoute(spec, t("forward.autoPort"))}
                    </span>
                  ))
                )}
              </span>
            </label>
          ))}
        </div>
        <label className="ssh-import-group">
          <span>{t("sshImport.addNewTo")}</span>
          <span className="select-wrap">
            <select
              className="select"
              value={groupId}
              onChange={(event) => setGroupId(event.target.value)}
            >
              <option value="">{t("sshImport.noGroupOption")}</option>
              {sshGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.label}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" className="select-chevron" />
          </span>
        </label>
        <span className="confirm-dialog-hint">{t("sshImport.hint")}</span>
        {selectedForwards > 0 && (
          <span className="confirm-dialog-hint">{t("sshImport.forwardAutoStart")}</span>
        )}
        {error && <div className="dialog-error">{error}</div>}
      </div>
      <div className="dialog-footer confirm-dialog-footer">
        <span className="confirm-dialog-keys">
          {t("sshImport.selectedCount", { selected: selected.size, total: preview.entries.length })}
        </span>
        <button type="button" className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="btn is-primary"
          disabled={busy || selected.size === 0}
          onClick={() => void submit()}
        >
          {t("sshImport.importButton")}
        </button>
      </div>
    </ModalDialog>
  );
}
