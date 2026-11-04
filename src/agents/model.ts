import { create } from "zustand";
export type AgentTool = "pi" | "opencode";
export type AgentView = "compose" | "diagnostics";
interface AgentState {
  open: boolean;
  recognized: Record<string, string | null>;
  drafts: Record<string, string>;
  initialView: AgentView;
  senderAgentMode: boolean;
  composeRequest: number;
}
export const useAgents = create<AgentState>(() => ({
  open: false,
  recognized: {},
  drafts: {},
  initialView: "compose",
  senderAgentMode: false,
  composeRequest: 0,
}));
export function openAgentView(view: AgentView) {
  useAgents.setState({ open: true, initialView: view });
}
export function showAgentComposer() {
  useAgents.setState((state) => ({
    senderAgentMode: true,
    composeRequest: state.composeRequest + 1,
  }));
}
