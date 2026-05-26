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

    // Permission mode: AgentDeck is a remote control for YOUR OWN laptop, so we
    // bypass permission gates by default. Without this, every tool call (mkdir,
    // Write, Edit, Bash) waits on an interactive prompt that the dashboard has
    // no UI to surface, hanging the run. This matches the user's local
    // `claude --dangerously-skip-permissions` posture.
    //
    // Override via env: AGENTDECK_PERMISSION_MODE=default (or acceptEdits, etc.)
    const permissionMode =
      process.env.AGENTDECK_PERMISSION_MODE || "bypassPermissions";

    const sdkOptions: Record<string, unknown> = {
      cwd: opts.cwd,
      permissionMode,
      // Extended thinking — Claude's chain-of-thought. Opus 4.6+ defaults to
      // adaptive, but we set it explicitly so behavior is stable across model
      // upgrades. `display: 'summarized'` is required: without it the SDK
      // emits thinking content blocks in the wire format but stripped from
      // the JSON stream (i.e. the model thinks but the dashboard never sees
      // it). The dashboard renders these as collapsible italic blocks.
      thinking: { type: "adaptive", display: "summarized" },
      // When Claude spawns a subagent (e.g. via the Task tool), forward the
      // subagent's text + thinking too. Without this, we'd only see the
      // parent's tool_use heartbeats and the user would think the agent is
      // stuck for minutes while a subagent silently grinds.
      forwardSubagentText: true,
    };
    if (permissionMode === "bypassPermissions") {
      // SDK requires this acknowledgement flag alongside bypassPermissions.
      sdkOptions.allowDangerouslySkipPermissions = true;
    }
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

        // normalize() returns an array because a single assistant SDK frame
        // can contain multiple content blocks (thinking + text + tool_use),
        // each of which we want to surface as its own row in the dashboard.
        for (const msg of normalize(sdkMsg)) yield msg;
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
 * Convert a Claude SDK message into ZERO OR MORE protocol AgentMessages.
 *
 * Why an array: one SDK assistant frame can carry several content blocks
 * (`thinking`, `text`, `tool_use`, `tool_result`). Collapsing them into a
 * single AgentMessage was lossy — extended thinking disappeared, and chained
 * tool_use calls would clobber each other. Emitting one row per block keeps
 * the dashboard timeline faithful to what the model actually produced.
 *
 * What we KEEP and how:
 *  - `thinking` block      → AgentMessage { type: "thinking", thinking: "..." }
 *  - `redacted_thinking`   → AgentMessage { type: "redacted_thinking" }  (no body)
 *  - `text` block          → AgentMessage { type: "assistant", text: "..." }
 *  - `tool_use` block      → AgentMessage { type: "tool_use",  tool: {...} }
 *  - `tool_result` block   → AgentMessage { type: "tool_result", toolResult: {...} }
 *
 * What we DROP entirely:
 *  - `system` frames (init, model name, mcp readiness, etc.)
 *  - `result` frames (duplicate final assistant text from `print` mode)
 *  - blocks of unknown type with no usable payload
 */
function normalize(sdkMsg: unknown): AgentMessage[] {
  const m = sdkMsg as {
    type?: string;
    subtype?: string;
    message?: {
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        input?: unknown;
        content?: unknown;
        is_error?: boolean;
      }>;
    };
    result?: string;
  };

  if (m.type === "system") return [];
  if (m.type === "result") return [];
  // SDK 0.3+ emits these as a heartbeat for rate limit windows. Useful for
  // power-user UIs that want to draw a quota bar; useless noise in our chat
  // timeline. Drop until we have a place to render them.
  if (m.type === "rate_limit_event") return [];
  if (m.type === "stream_event") return [];

  if (m.type === "assistant" || m.type === "user") {
    const out: AgentMessage[] = [];
    for (const part of m.message?.content ?? []) {
      if (part.type === "text" && typeof part.text === "string" && part.text.length) {
        out.push({ type: m.type, raw: sdkMsg, text: part.text });
      } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.length) {
        // Extended thinking. Surface it as its own row so the dashboard can
        // collapse / dim it without affecting the regular reply rendering.
        out.push({ type: "thinking", raw: part, thinking: part.thinking });
      } else if (part.type === "redacted_thinking") {
        // The body is encrypted; we still want a placeholder so the user
        // sees "Claude thought about this but the content is redacted".
        out.push({ type: "redacted_thinking", raw: part });
      } else if (part.type === "tool_use") {
        out.push({
          type: "tool_use",
          raw: part,
          tool: { name: part.name ?? "?", input: part.input },
        });
      } else if (part.type === "tool_result") {
        out.push({
          type: "tool_result",
          raw: part,
          toolResult: { output: part.content, isError: part.is_error },
        });
      }
    }
    return out;
  }

  return [{ type: m.type ?? "unknown", raw: sdkMsg }];
}
