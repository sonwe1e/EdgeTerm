import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { inspectAgent, insertPrompt, type Installation } from "../agents/api";
import { piConfigs, usePiResumeHint, type PiConfig } from "../agents/diagnostics";
import { useAgents, type AgentTool, type AgentView } from "../agents/model";
import { errorText } from "../errorInfo";
import { chooseAgentReference, selectedAgentText } from "../agents/composer";
import { editDraft } from "../agents/draftEdit";
import { useStore } from "../store";
import { getController } from "../terminalRegistry";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

/** Optional agent surface; terminal ownership and permission prompts stay with the CLI. */
export function AgentDialog() {
  const open = useAgents((s) => s.open);
  return open ? <AgentDialogBody /> : null;
}
function AgentDialogBody() {
  const t = useT();
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const [target, setTarget] = useState(activeId ?? "");
  const tab = tabs.find((row) => row.info.id === target);
  const controller = getController(target);
  const revision = controller?.connectionRevision ?? -1;
  const live = tab?.state === "connected" && (tab.info.kind === "local" || tab.info.kind === "ssh");
  const [tool, setTool] = useState<AgentTool>(
    useAgents.getState().recognized[target] === "pi" ? "pi" : "opencode",
  );
  const [directory, setDirectory] = useState(controller?.reportedCwd?.path ?? "");
  const prompt = useAgents((state) => state.drafts[target] ?? "");
  const input = useRef<HTMLTextAreaElement>(null);
  const setPrompt = (value: string | ((text: string) => string)) =>
    useAgents.setState((state) => ({
      drafts: {
        ...state.drafts,
        [target]: typeof value === "function" ? value(state.drafts[target] ?? "") : value,
      },
    }));
  const [view, setView] = useState<AgentView>(useAgents.getState().initialView);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [configs, setConfigs] = useState<PiConfig[]>([]);
  const [metrics, setMetrics] = useState(() => controller?.agentDiagnostics());
  const generation = useRef(0);
  const currentBinding = useRef("");
  const binding = `${target}:${revision}:${tool}`;
  currentBinding.current = binding;
  const remoteId = tab?.info.kind === "ssh" ? target : null;
  const close = () => useAgents.setState({ open: false });
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setError("");
    setNotice("");
    setInstallation(null);
    setConfigs([]);
    setMetrics(getController(target)?.agentDiagnostics());
    return () => {
      generation.current++;
    };
  }, [target, revision, tool]);
  useEffect(() => {
    const currentController = getController(target);
    const reported = currentController?.reportedCwd?.path;
    setDirectory(reported ?? "");
    if (reported || !live) return;
    let cancelled = false;
    void api
      .sessionCwd(target)
      .then((path) => {
        if (!cancelled && getController(target)?.connectionRevision === revision)
          setDirectory((previous) => previous || path);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [target, revision, live]);

  const run = async (work: (current: () => boolean) => Promise<void>) => {
    if (busy || !live) return;
    const token = ++generation.current;
    const began = currentBinding.current;
    const current = () =>
      generation.current === token &&
      currentBinding.current === began &&
      useStore.getState().tabs.some((row) => row.info.id === target && row.state === "connected") &&
      getController(target)?.connectionRevision === revision;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work(current);
    } catch (error) {
      if (current()) setError(errorText(error));
    } finally {
      if (current()) setBusy(false);
    }
  };
  const inspect = () =>
    run(async (current) => {
      const result = await inspectAgent(target, tool);
      let dir = directory;
      if (!dir) {
        try {
          dir = await api.sessionCwd(target);
        } catch {
          /* An unknown project must not be replaced with the home directory. */
        }
      }
      if (!current()) return;
      setDirectory(dir);
      setInstallation(result);
      setMetrics(controller?.agentDiagnostics());
      if (tool === "pi") {
        const found = await piConfigs(remoteId, result, dir);
        if (current()) setConfigs(found);
      }
    });
  const insert = () => {
    if (!insertPrompt(target, revision, prompt)) {
      setError(t("agent.inputUnavailable"));
      return;
    }
    setPrompt("");
    close();
    requestAnimationFrame(() => getController(target)?.focus());
  };
  const addFile = () =>
    run(async (current) => {
      const path = await chooseAgentReference(target, directory, current);
      if (path && current())
        editDraft(
          input.current,
          t("agent.fileReference", { path: JSON.stringify(path) }),
          setPrompt,
        );
    });
  const attention = tabs.filter(
    (row) => row.activityKind === "ai" && row.commandActivity === "complete",
  );
  const views = ["compose", "diagnostics"] as const;
  return (
    <ModalDialog
      open
      title={t("agent.title")}
      ariaLabel={t("agent.title")}
      onClose={close}
      dismissable={false}
      contentClassName="agent-dialog"
    >
      <div className={`agent-target${view === "compose" ? " is-compose" : ""}`}>
        <label>
          {t("agent.target")}
          <select
            className="select"
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
          >
            {tabs
              .filter((row) => row.info.kind === "local" || row.info.kind === "ssh")
              .map((row) => (
                <option key={row.info.id} value={row.info.id}>
                  {row.info.name} · {row.info.kind === "ssh" ? row.info.address : t("agent.local")}
                </option>
              ))}
          </select>
        </label>
        {view === "diagnostics" && (
          <label>
            {t("agent.tool")}
            <select
              className="select"
              value={tool}
              disabled={busy}
              onChange={(e) => setTool(e.target.value as AgentTool)}
            >
              <option value="opencode">OpenCode</option>
              <option value="pi">Pi</option>
            </select>
          </label>
        )}
      </div>
      <label className="agent-directory">
        {t("agent.directory")}
        <input
          className="input"
          value={directory}
          disabled={busy}
          onChange={(e) => {
            setDirectory(e.target.value);
            setConfigs([]);
          }}
          placeholder={t("agent.directoryHint")}
        />
      </label>
      <nav className="agent-tabs" aria-label={t("agent.title")}>
        {views.map((name) => (
          <button
            type="button"
            key={name}
            className={view === name ? "is-active" : ""}
            aria-pressed={view === name}
            onClick={() => setView(name)}
          >
            {t(`agent.${name}`)}
          </button>
        ))}
      </nav>
      <div className="agent-body">
        {attention.length > 0 && (
          <div className="agent-attention">
            <small>{t("agent.attentionHint")}</small>
            <div className="agent-actions">
              {attention.map((row) => (
                <button
                  type="button"
                  key={row.info.id}
                  className="btn"
                  onClick={() => {
                    setTarget(row.info.id);
                    useStore.getState().setActive(row.info.id);
                  }}
                >
                  {row.info.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {!live && <p className="agent-hint">{t("agent.connectFirst")}</p>}
        {view === "compose" && (
          <>
            <p className="agent-hint">{t("agent.composeHint")}</p>
            <textarea
              ref={input}
              key={target}
              className="agent-prompt input"
              aria-label={t("agent.prompt")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              spellCheck={false}
              autoCapitalize="none"
            />
            <div className="agent-actions">
              <button
                className="btn"
                disabled={!live}
                onClick={() => {
                  try {
                    const selection = selectedAgentText(target, revision);
                    editDraft(input.current, selection, setPrompt);
                    setError("");
                  } catch (error) {
                    setError(errorText(error));
                  }
                }}
              >
                {t("agent.addSelection")}
              </button>
              <button className="btn" disabled={!live || busy} onClick={() => void addFile()}>
                {t("agent.addFile")}
              </button>
              <button
                className="btn is-primary"
                disabled={!live || busy || !prompt}
                onClick={insert}
              >
                {t("agent.insert")}
              </button>
            </div>
            <label className="agent-check">
              <input
                type="checkbox"
                checked={controller?.agentKeyPassthrough ?? false}
                disabled={!live}
                onChange={(e) => {
                  if (controller) controller.agentKeyPassthrough = e.target.checked;
                  setMetrics(controller?.agentDiagnostics());
                }}
              />
              {t("agent.passTabs")}
            </label>
            <p className="agent-hint">{t("agent.attachmentHint")}</p>
          </>
        )}
        {view === "diagnostics" && (
          <>
            <div className="agent-actions">
              <button className="btn" disabled={busy || !live} onClick={() => void inspect()}>
                {t("agent.inspect")}
              </button>
              <span className="agent-hint">{t("agent.inspectionHint")}</span>
            </div>
            {installation && (
              <dl className="agent-facts">
                <dt>{t("agent.executable")}</dt>
                <dd>{installation.executable || t("agent.notFound")}</dd>
                <dt>{t("agent.version")}</dt>
                <dd>{installation.version || t("agent.stateUnknown")}</dd>
              </dl>
            )}
            {metrics && (
              <dl className="agent-facts">
                <dt>{t("agent.screen")}</dt>
                <dd>
                  {metrics.buffer} · {metrics.cols}×{metrics.rows} · {metrics.mouse}
                </dd>
                <dt>{t("agent.historyRows")}</dt>
                <dd>{metrics.historyRows}</dd>
                <dt>{t("agent.output")}</dt>
                <dd>
                  {metrics.outputBytes.toLocaleString()} B · {metrics.parseMs.toFixed(1)} ms
                </dd>
              </dl>
            )}
            <p className="agent-hint">{t("agent.metricsHint")}</p>
            {configs.map((config) => (
              <div className="agent-config" key={config.path}>
                <strong>{t(config.scope === "global" ? "agent.global" : "agent.project")}</strong>
                <code>{config.path}</code>
                <span>
                  {config.error
                    ? t("agent.configUnreadable")
                    : `fullscreenExitOutput: ${config.exit ?? t("agent.inherited")}`}
                </span>
                {config.error && <small title={config.error}>{config.error}</small>}
                {config.file && config.exit !== "resume-hint" && (
                  <button
                    className="btn"
                    disabled={busy || !live}
                    onClick={() =>
                      void run(async (current) => {
                        await usePiResumeHint(remoteId, config);
                        const found = await piConfigs(remoteId, installation!, directory);
                        if (current()) {
                          setConfigs(found);
                          setNotice(t("agent.reloadPi"));
                        }
                      })
                    }
                  >
                    {t("agent.resumeHint")}
                  </button>
                )}
              </div>
            ))}
            {tool === "pi" && <p className="agent-hint">{t("agent.piExitHint")}</p>}
          </>
        )}
      </div>
      {error && (
        <div className="dialog-error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="dialog-footer">
        <span role="status">
          {busy
            ? t("common.loading")
            : tab
              ? `${tab.info.kind.toUpperCase()} · ${tab.info.address}`
              : ""}
        </span>
        <button className="btn" onClick={close}>
          {t("common.close")}
        </button>
      </div>
    </ModalDialog>
  );
}
