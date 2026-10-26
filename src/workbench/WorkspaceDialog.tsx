import { lazy, Suspense, useRef, useState } from "react";
import { ModalDialog } from "../components/ModalDialog";
import { ask } from "../nativeDialog";
import { Icon } from "../components/icons";
import { errorText } from "../errorInfo";
import type { MessageKey } from "../i18n";
import { useStore } from "../store";
import { useT } from "../useT";
import { type SessionProfile } from "../types";
import { normalizeServer, serverLabel } from "./model";
import type { Workspace, WorkspaceCommand, WorkspaceCommandKind } from "./types";

const KINDS: WorkspaceCommandKind[] = ["train", "validate", "infer", "shell", "other"];
const SessionDialog = lazy(() =>
  import("../components/SessionDialog").then((module) => ({ default: module.SessionDialog })),
);
const KIND_KEYS: Record<WorkspaceCommandKind, MessageKey> = {
  train: "wb.kindTrain",
  validate: "wb.kindValidate",
  infer: "wb.kindInfer",
  shell: "wb.kindShell",
  other: "wb.kindOther",
};

export function WorkspaceDialog({
  workspace,
  onClose,
  onSubmit,
}: {
  workspace: Workspace | null;
  onClose: () => void;
  onSubmit: (workspace: Workspace) => Promise<void>;
}) {
  const t = useT();
  // A project needs a shell for its terminal and runs; SFTP-only logins are
  // still available to the Filer, but not as a project server.
  const profiles = useStore((state) => state.profiles).filter((profile) => profile.kind === "ssh");
  const [name, setName] = useState(workspace?.name ?? "");
  const [profileId, setProfileId] = useState(workspace?.server.profileId ?? profiles[0]?.id ?? "");
  const [root, setRoot] = useState(workspace?.root ?? "");
  const [env, setEnv] = useState(workspace?.env ?? "");
  const [runRoot, setRunRoot] = useState(workspace?.runRoot ?? "");
  const [commands, setCommands] = useState<WorkspaceCommand[]>(workspace?.commands ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingServer, setAddingServer] = useState(false);
  const values = JSON.stringify({ name, profileId, root, env, runRoot, commands });
  const original = useRef(values);
  const closing = useRef(false);
  const requestClose = async () => {
    if (busy || closing.current || addingServer) return;
    closing.current = true;
    try {
      if (values === original.current || (await ask(t("wb.discardForm"), { kind: "warning" })))
        onClose();
    } finally {
      closing.current = false;
    }
  };

  const profile: SessionProfile | undefined = profiles.find((item) => item.id === profileId);
  const missingProfile =
    Boolean(workspace) && !profiles.some((item) => item.id === workspace?.server.profileId);

  const updateCommand = (index: number, patch: Partial<WorkspaceCommand>) => {
    setCommands((current) =>
      current.map((command, at) => (at === index ? { ...command, ...patch } : command)),
    );
  };

  const submit = async () => {
    if (!name.trim()) {
      setError(t("wb.nameRequired"));
      return;
    }
    if (!root.trim()) {
      setError(t("wb.rootRequired"));
      return;
    }
    if (!profile) {
      setError(t("wb.serverRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        id: workspace?.id ?? "",
        name: name.trim(),
        server: normalizeServer({
          profileId: profile.id,
          name: profile.name,
          host: profile.host ?? "",
          port: profile.port ?? 22,
          username: profile.username ?? "",
        }),
        root: root.trim(),
        env,
        commands: commands
          .filter((command) => command.command.trim())
          .map((command) => ({
            ...command,
            label: command.label.trim() || command.command.trim().split("\n")[0],
            command: command.command.trim(),
          })),
        runRoot: runRoot.trim(),
        baselineExperimentId: workspace?.baselineExperimentId ?? null,
        createdAt: workspace?.createdAt ?? 0,
        updatedAt: workspace?.updatedAt ?? 0,
      });
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <>
      <ModalDialog
        open
        onClose={() => void requestClose()}
        dismissable={false}
        ariaLabel={t("wb.newProject")}
        contentClassName="wb-form-dialog"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="wb-dialog-header">
            <strong>{workspace ? t("wb.edit") : t("wb.newProject")}</strong>
            <button
              type="button"
              className="wb-icon-button"
              aria-label={t("common.close")}
              onClick={() => void requestClose()}
              disabled={busy}
            >
              ×
            </button>
          </div>
          <div className="wb-form">
            <label className="wb-field">
              <span>{t("wb.projectName")}</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="vfi-ablation"
              />
            </label>
            <label className="wb-field">
              <span>{t("wb.server")}</span>
              <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                <option value="">—</option>
                {profiles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {serverLabel(
                      normalizeServer({
                        profileId: item.id,
                        name: item.name,
                        host: item.host ?? "",
                        port: item.port ?? 22,
                        username: item.username ?? "",
                      }),
                    )}
                  </option>
                ))}
              </select>
              {missingProfile && (
                <small className="wb-field-warning">{t("wb.profileMissing")}</small>
              )}
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => setAddingServer(true)}
              disabled={busy}
            >
              <Icon name="add" /> {t("wb.addServer")}
            </button>
            {profiles.length === 0 && <small>{t("wb.addServerHint")}</small>}
            <label className="wb-field">
              <span>{t("wb.codeDir")}</span>
              <input
                value={root}
                spellCheck={false}
                placeholder="/data/vfi/baseline"
                onChange={(event) => setRoot(event.target.value)}
              />
            </label>
            <label className="wb-field">
              <span>{t("wb.env")}</span>
              <textarea
                rows={2}
                value={env}
                spellCheck={false}
                placeholder="conda activate vfi"
                onChange={(event) => setEnv(event.target.value)}
              />
              <small>{t("wb.envHint")}</small>
            </label>
            <label className="wb-field">
              <span>{t("wb.runRoot")}</span>
              <input
                value={runRoot}
                spellCheck={false}
                placeholder={root ? `${root.replace(/\/+$/, "")}/.edgeterm/runs` : ""}
                onChange={(event) => setRunRoot(event.target.value)}
              />
              <small>{t("wb.runRootHint")}</small>
            </label>

            <div className="wb-field">
              <span>{t("wb.commands")}</span>
              {commands.map((command, index) => (
                <div className="wb-command-row" key={command.id || index}>
                  <input
                    aria-label={t("wb.commandLabel")}
                    value={command.label}
                    placeholder={t("wb.commandLabel")}
                    onChange={(event) => updateCommand(index, { label: event.target.value })}
                  />
                  <input
                    aria-label={t("wb.commandText")}
                    value={command.command}
                    spellCheck={false}
                    placeholder="python train.py --config configs/base.yaml"
                    onChange={(event) => updateCommand(index, { command: event.target.value })}
                  />
                  <select
                    aria-label={t("wb.commandKind")}
                    value={command.kind}
                    onChange={(event) =>
                      updateCommand(index, {
                        kind: event.target.value as WorkspaceCommandKind,
                      })
                    }
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(KIND_KEYS[kind])}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="wb-icon-button"
                    aria-label={t("common.delete")}
                    onClick={() =>
                      setCommands((current) => current.filter((_, at) => at !== index))
                    }
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn wb-mini"
                onClick={() =>
                  setCommands((current) => [
                    ...current,
                    {
                      id: crypto.randomUUID(),
                      label: "",
                      command: "",
                      kind: "train",
                    },
                  ])
                }
              >
                <Icon name="add" /> {t("wb.addCommand")}
              </button>
            </div>
          </div>
          {error && (
            <p className="wb-dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="wb-dialog-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void requestClose()}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn is-primary" disabled={busy}>
              {t("common.save")}
            </button>
          </div>
        </form>
      </ModalDialog>
      {addingServer && (
        <Suspense fallback={null}>
          <SessionDialog
            initial={null}
            sshOnly
            onClose={() => setAddingServer(false)}
            onSaved={(saved) => {
              setProfileId(saved.id);
              setError(null);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
