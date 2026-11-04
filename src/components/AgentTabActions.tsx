import { showAgentComposer, useAgents } from "../agents/model";
import { useStore } from "../store";
import { useT } from "../useT";
import { Icon } from "./icons";

export function AgentTabActions({ id }: { id: string }) {
  const t = useT();
  const tool = useAgents((s) => s.recognized[id]);
  const activate = () => useStore.getState().setActive(id);
  return (
    <div className="agent-tab-actions">
      {tool && (
        <span className="agent-tool-name">
          {tool === "opencode" ? "OpenCode" : tool === "pi" ? "Pi" : tool}
        </span>
      )}
      <button
        type="button"
        className="agent-compose-launch"
        title={t("agent.prompt")}
        onClick={() => {
          activate();
          showAgentComposer();
        }}
      >
        <Icon name="edit" />
        {t("agent.prompt")}
      </button>
    </div>
  );
}
