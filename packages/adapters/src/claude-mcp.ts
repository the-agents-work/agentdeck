import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type AnyServer = Record<string, unknown>;

/**
 * Loads MCP server config the way Claude Code CLI surfaces it to the user:
 * the GLOBAL `mcpServers` block at the top of `~/.claude.json` merged with
 * the per-project block under `projects[<cwd>].mcpServers`.
 *
 * Why this exists: when the @anthropic-ai/claude-agent-sdk is invoked with
 * a cwd that has an explicit (empty) `mcpServers: {}` entry in the user's
 * `~/.claude.json` projects map, it follows that override and ignores the
 * global servers — so things the user configured "once for all projects"
 * (e.g. taw-mem-cloud, shipkit) silently disappear. The CLI's TUI hides
 * this by merging the two layers itself; we replicate that here so the
 * dashboard behaves the same as `claude` in the terminal.
 *
 * Returns a record ready to pass straight to `query({ options: { mcpServers } })`.
 * Project-level entries win on name collision, matching CLI precedence.
 */
export function loadMergedMcpServers(cwd?: string): Record<string, AnyServer> {
  const cfg = readClaudeJson();
  if (!cfg) return {};
  const global = isRecord(cfg.mcpServers) ? cfg.mcpServers : {};
  let project: Record<string, unknown> = {};
  if (cwd && isRecord(cfg.projects)) {
    const entry = cfg.projects[cwd];
    if (isRecord(entry) && isRecord(entry.mcpServers)) {
      project = entry.mcpServers;
    }
  }
  const merged: Record<string, AnyServer> = {};
  for (const [k, v] of Object.entries(global)) {
    if (isRecord(v)) merged[k] = v;
  }
  for (const [k, v] of Object.entries(project)) {
    if (isRecord(v)) merged[k] = v;
  }
  return merged;
}

function readClaudeJson(): Record<string, unknown> | null {
  // `~/.claude.json` is the canonical CLI state file (sibling of ~/.claude/).
  // We deliberately don't follow $CLAUDE_CONFIG_DIR or similar — the SDK
  // already does that for its own purposes; we only need to recover the
  // global server list that the SDK's per-cwd resolution swallows.
  const path = join(homedir(), ".claude.json");
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
