import type { AgentMessage, AgentName, PromptImage } from "@pocket-agents/protocol";

export type AdapterRunOptions = {
  prompt: string;
  /** Optional images attached to this turn. Adapters that support multimodal
   *  input (Claude) should forward as SDK content blocks; ones that don't
   *  (Codex CLI today) should ignore them, leaving the prompt text intact. */
  images?: PromptImage[];
  // Adapter-native session id to resume from (e.g. Claude session_id or Codex thread id).
  // null = start a fresh session.
  resumeFromNativeId?: string | null;
  // Working directory to run the agent in. Defaults to process.cwd().
  cwd?: string;
  // AbortSignal that, when triggered, asks the adapter to stop the run.
  signal?: AbortSignal;
};

export type AdapterRunResult = {
  // The adapter-native session id (or last seen one) so callers can resume next time.
  nativeSessionId: string | null;
  // Total runtime in ms.
  durationMs: number;
  // True if the run ended normally.
  ok: boolean;
};

export interface AgentAdapter {
  readonly name: AgentName;

  /**
   * Run a single user prompt to completion. Yields normalized AgentMessage
   * events as they arrive (assistant chunks, tool uses, results).
   *
   * The caller is responsible for persisting messages — the adapter is stateless.
   *
   * Returns the final native session id so the caller can resume next turn.
   */
  run(
    opts: AdapterRunOptions,
  ): AsyncGenerator<AgentMessage, AdapterRunResult, void>;
}
