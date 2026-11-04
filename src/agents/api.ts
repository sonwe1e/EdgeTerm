import { invoke } from "@tauri-apps/api/core";
import { getController } from "../terminalRegistry";
import { useStore } from "../store";
import type { AgentTool } from "./model";

export interface Installation {
  executable: string;
  version: string;
  home: string;
  configRoot: string;
}
export const inspectAgent = (id: string, tool: AgentTool): Promise<Installation> =>
  invoke("coding_agent_inspect", { id, tool });
/** Input is bound to one live connection, even if the UI switches tabs meanwhile. */
export function insertPrompt(id: string, revision: number, text: string): boolean {
  const tab = useStore.getState().tabs.find((tab) => tab.info.id === id);
  const controller = getController(id);
  return tab?.state === "connected" && controller?.insertAgentPrompt(text, revision) === true;
}
