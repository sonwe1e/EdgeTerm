import { useEffect, useRef, useState } from "react";
import { sessionCwd } from "../../api";
import { insertPrompt } from "../../agents/api";
import { chooseAgentReference, selectedAgentText } from "../../agents/composer";
import { editDraft } from "../../agents/draftEdit";
import { openAgentView, useAgents } from "../../agents/model";
import { errorText } from "../../errorInfo";
import { useStore } from "../../store";
import { getController } from "../../terminalRegistry";
import { useT } from "../../useT";
import { Icon } from "../icons";

export function AgentComposer({ onCollapse }: { onCollapse?: () => void }) {
  const t = useT();
  const tab = useStore((s) => s.tabs.find((row) => row.info.id === s.activeId));
  const id = tab?.info.id ?? "";
  const controller = getController(id);
  const revision = controller?.connectionRevision ?? -1;
  const text = useAgents((s) => s.drafts[id] ?? "");
  const request = useAgents((s) => s.composeRequest);
  const tool = useAgents((s) => s.recognized[id]);
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const binding = `${id}:${revision}`;
  const latest = useRef(binding);
  latest.current = binding;
  const live = tab?.state === "connected" && (tab.info.kind === "local" || tab.info.kind === "ssh");
  const setText = (value: string) =>
    useAgents.setState((s) => ({ drafts: { ...s.drafts, [id]: value } }));
  useEffect(() => {
    setBusy(false);
    setError("");
    const expectedBinding = `${id}:${revision}`;
    const reported = getController(id)?.reportedCwd?.path;
    setDirectory(reported ?? "");
    let cancelled = false;
    if (!reported && live)
      void sessionCwd(id)
        .then((path) => {
          if (!cancelled && latest.current === expectedBinding) setDirectory(path);
        })
        .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, revision, live]);
  useEffect(() => {
    input.current?.focus();
  }, [request]);
  useEffect(
    () => () => {
      latest.current = "";
    },
    [],
  );
  const insert = () => {
    if (busy || !insertPrompt(id, revision, text)) {
      setError(t("agent.inputUnavailable"));
      return;
    }
    editDraft(input.current, "", setText, false);
    setError("");
    controller?.focus();
  };
  const addFile = async () => {
    if (!live || busy) return;
    const captured = binding;
    const current = () =>
      latest.current === captured &&
      getController(id)?.connectionRevision === revision &&
      useStore.getState().tabs.some((row) => row.info.id === id && row.state === "connected");
    setBusy(true);
    setError("");
    try {
      const path = await chooseAgentReference(id, directory, current);
      if (path && current())
        editDraft(input.current, t("agent.fileReference", { path: JSON.stringify(path) }), setText);
    } catch (error) {
      if (current()) setError(errorText(error));
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <div className="agent-inline">
      <div className="panel-header sender-header">
        <div className="panel-title is-sender">
          <Icon name="send" />
          {t("panel.sender")}
        </div>
        <div className="agent-inline-tabs">
          <button type="button" onClick={() => useAgents.setState({ senderAgentMode: false })}>
            {t("agent.commands")}
          </button>
          <button type="button" className="is-active" aria-pressed="true">
            {t("agent.prompt")}
          </button>
        </div>
        <div className="sender-options">
          {onCollapse && (
            <button
              type="button"
              className="sender-collapse"
              aria-label={t("sender.collapse")}
              onClick={onCollapse}
            >
              <Icon name="arrow-down" />
            </button>
          )}
        </div>
      </div>
      <div className="agent-inline-body">
        <div className="agent-inline-target">
          <strong>{tool || "Agent"}</strong>
          <span>
            {tab
              ? `${tab.info.name} · ${tab.info.kind === "ssh" ? tab.info.address : t("agent.local")}`
              : t("agent.connectFirst")}
          </span>
          <code title={directory}>{directory}</code>
        </div>
        <textarea
          key={id}
          ref={input}
          className="input agent-inline-input"
          aria-label={t("agent.prompt")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("agent.inlineHint")}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (text && live) insert();
            }
          }}
        />
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <small className="agent-hint">{t("agent.inlineSubmitHint")}</small>
      </div>
      <div className="agent-actions agent-inline-actions">
        <button
          type="button"
          className="btn"
          disabled={!live || busy}
          onClick={() => void addFile()}
        >
          {t("agent.addFile")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!live || busy}
          onClick={() => {
            try {
              editDraft(input.current, selectedAgentText(id, revision), setText);
              setError("");
              input.current?.focus();
            } catch (error) {
              setError(errorText(error));
            }
          }}
        >
          {t("agent.addSelection")}
        </button>
        <button
          type="button"
          className="btn is-primary"
          disabled={!live || !text || busy}
          onClick={insert}
        >
          {t("agent.insert")} <kbd>Ctrl+Enter</kbd>
        </button>
        <button type="button" className="btn" onClick={() => openAgentView("diagnostics")}>
          {t("agent.diagnostics")}
        </button>
      </div>
    </div>
  );
}
