import { spawn } from "node:child_process";
import type { AgentMessage } from "@agentdeck/protocol";
import type {
  AgentAdapter,
  AdapterRunOptions,
  AdapterRunResult,
} from "./types.js";

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
};

/**
 * Codex adapter — wraps `codex exec --json`.
 *
 * Session resume: Codex emits a `thread.started` event with the thread id.
 * We persist that id and pass it back through `codex exec resume` next turn.
 */
export class CodexCliAdapter implements AgentAdapter {
  readonly name = "codex" as const;

  async *run(
    opts: AdapterRunOptions,
  ): AsyncGenerator<AgentMessage, AdapterRunResult, void> {
    const startedAt = Date.now();
    let nativeSessionId: string | null = opts.resumeFromNativeId ?? null;
    let ok = true;
    const stderr: string[] = [];

    const child = spawnCodex(opts);

    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1500).unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr.push(chunk);
      if (stderr.join("").length > 8000) stderr.splice(0, stderr.length - 4);
    });

    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });

    try {
      if (!child.stdout) {
        throw new Error("codex stdout was not available");
      }

      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const msg = parseCodexLine(line, (threadId) => {
            nativeSessionId = threadId;
          });
          if (msg) yield msg;
        }
      }

      const trailing = buffer.trim();
      if (trailing) {
        const msg = parseCodexLine(trailing, (threadId) => {
          nativeSessionId = threadId;
        });
        if (msg) yield msg;
      }

      const code = await exit;
      if (code !== 0) {
        ok = false;
        yield {
          type: "error",
          raw: { code, stderr: compact(stderr.join("")) },
          text: compact(stderr.join("")) || `codex exited with code ${code}`,
        };
      }
    } catch (err) {
      ok = false;
      yield {
        type: "error",
        raw: { message: err instanceof Error ? err.message : String(err) },
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (opts.signal) opts.signal.removeEventListener("abort", abort);
    }

    return {
      nativeSessionId,
      durationMs: Date.now() - startedAt,
      ok,
    };
  }
}

function spawnCodex(opts: AdapterRunOptions) {
  const bin = process.env.AGENTDECK_CODEX_BIN || "codex";
  const args = buildCodexArgs(opts);

  return spawn(bin, args, {
    cwd: opts.cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function buildCodexArgs(opts: AdapterRunOptions): string[] {
  const args: string[] = [];

  const model = process.env.AGENTDECK_CODEX_MODEL;
  if (model) args.push("-m", model);

  // Remote control should not hang on local approval prompts. The sandbox can
  // still be tightened with AGENTDECK_CODEX_SANDBOX=workspace-write/read-only.
  args.push("-a", process.env.AGENTDECK_CODEX_APPROVAL || "never");
  args.push("-s", process.env.AGENTDECK_CODEX_SANDBOX || "danger-full-access");

  if (opts.cwd) args.push("-C", opts.cwd);

  if (opts.resumeFromNativeId) {
    args.push(
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      opts.resumeFromNativeId,
      opts.prompt,
    );
  } else {
    args.push("exec", "--json", "--skip-git-repo-check", opts.prompt);
  }

  return args;
}

function parseCodexLine(
  line: string,
  setThreadId: (threadId: string) => void,
): AgentMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let event: CodexEvent;
  try {
    event = JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }

  if (event.type === "thread.started" && event.thread_id) {
    setThreadId(event.thread_id);
    return null;
  }

  if (event.type !== "item.started" && event.type !== "item.completed") {
    return null;
  }

  const item = event.item;
  if (!item) return null;

  if (event.type === "item.started" && item.type === "command_execution") {
    return {
      type: "assistant",
      raw: event,
      tool: { name: "shell", input: { command: item.command } },
    };
  }

  if (event.type === "item.completed" && item.type === "command_execution") {
    return {
      type: "tool_result",
      raw: event,
      toolResult: {
        output: item.aggregated_output ?? "",
        isError: typeof item.exit_code === "number" && item.exit_code !== 0,
      },
    };
  }

  if (event.type === "item.completed" && item.type === "agent_message") {
    return {
      type: "assistant",
      raw: event,
      text: item.text ?? "",
    };
  }

  return null;
}

function compact(text: string): string {
  return text
    .trim()
    .replace(/\n{3,}/g, "\n\n")
    .slice(-4000);
}
