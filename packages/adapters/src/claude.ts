import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentMessage } from "@agentdeck/protocol";
import type { AgentAdapter, AdapterRunOptions, AdapterRunResult } from "./types.js";

/**
 * Claude Code adapter — wraps @anthropic-ai/claude-agent-sdk's `query()`.
 *
 * The SDK runs the same agent loop as the `claude` CLI:
 * MCP servers, hooks, tools, and ~/.claude config are all honored.
 *
 * Session resume: we track the SDK's `session_id` from the `system.init`
 * event and pass it back via `options.resume` on the next turn.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude" as const;

  async *run(
    opts: AdapterRunOptions,
  ): AsyncGenerator<AgentMessage, AdapterRunResult, void> {
    const startedAt = Date.now();
    let nativeSessionId: string | null = opts.resumeFromNativeId ?? null;
    let ok = true;

    const sdkOptions: Record<string, unknown> = {
      cwd: opts.cwd,
    };
    if (opts.resumeFromNativeId) {
      sdkOptions.resume = opts.resumeFromNativeId;
    }
    if (opts.signal) {
      sdkOptions.abortController = abortControllerFromSignal(opts.signal);
    }

    try {
      // The SDK's query() returns an AsyncIterable of SDKMessage.
      const stream = query({
        prompt: opts.prompt,
        options: sdkOptions as Parameters<typeof query>[0]["options"],
      });

      for await (const sdkMsg of stream) {
        // Pull session_id out of system.init early so we can resume next turn.
        const maybeId = (sdkMsg as { session_id?: string }).session_id;
        if (maybeId) nativeSessionId = maybeId;

        const norm = normalize(sdkMsg);
        if (norm) yield norm;
      }
    } catch (err) {
      ok = false;
      yield {
        type: "error",
        raw: { message: err instanceof Error ? err.message : String(err) },
        text: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      nativeSessionId,
      durationMs: Date.now() - startedAt,
      ok,
    };
  }
}

function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  return ctrl;
}

/**
 * Convert a Claude SDK message into the protocol's AgentMessage shape, OR
 * return null to drop the message entirely (system metadata, redundant final
 * result, empty content). The runner won't persist or fan-out null returns.
 *
 * What we KEEP:
 *  - assistant text chunks
 *  - assistant tool_use parts (rendered as cards)
 *  - tool_result parts (rendered as cards, possibly errored)
 *  - explicit "error" frames
 *
 * What we DROP:
 *  - system.init and other system metadata frames (model name, mcp init...).
 *    They expose internal SDK state to the user with no value.
 *  - result frames. They duplicate the final assistant text — Claude SDK emits
 *    this as a synchronous summary for `print` mode. In our streaming UI it
 *    just shows the same answer twice.
 *  - assistant frames with no text AND no tool — empty deltas the SDK sometimes
 *    flushes mid-stream.
 */
function normalize(sdkMsg: unknown): AgentMessage | null {
  const m = sdkMsg as {
    type?: string;
    subtype?: string;
    message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }> };
    result?: string;
  };

  if (m.type === "system") return null;
  if (m.type === "result") return null;

  const out: AgentMessage = {
    type: m.type ?? "unknown",
    raw: sdkMsg,
  };

  if (m.type === "assistant" || m.type === "user") {
    const parts = m.message?.content ?? [];
    const textParts: string[] = [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
      } else if (part.type === "tool_use") {
        out.tool = { name: part.name ?? "?", input: part.input };
      } else if (part.type === "tool_result") {
        out.toolResult = { output: part.content, isError: part.is_error };
      }
    }
    if (textParts.length) out.text = textParts.join("");
    // Drop empty assistant frames — no text, no tool call, no tool result.
    if (m.type === "assistant" && !out.text && !out.tool && !out.toolResult) {
      return null;
    }
  }

  return out;
}
