export type { AgentAdapter, AdapterRunOptions, AdapterRunResult } from "./types.js";
export { ClaudeCodeAdapter } from "./claude.js";
import { ClaudeCodeAdapter } from "./claude.js";
import type { AgentAdapter } from "./types.js";
import type { AgentName } from "@agentdeck/protocol";

export const adapters: Record<AgentName, AgentAdapter> = {
  claude: new ClaudeCodeAdapter(),
  codex: new ClaudeCodeAdapter(), // placeholder until CodexAdapter lands
};
