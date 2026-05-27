export const PROTOCOL_VERSION = 1;

export type AgentName = "claude" | "codex";

/** Inline image attachment carried with a user prompt. base64 is the raw
 *  payload without the data:URL prefix; mime tells the adapter which media
 *  type to declare to the model. Kept tiny — server caps total size before
 *  forwarding to avoid pushing megabytes of clipboard PNG through the SDK. */
export type PromptImage = {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data_base64: string;
};

export type SessionStatus = "idle" | "running" | "error" | "done";

export type SessionSummary = {
  id: string;
  title: string;
  agent: AgentName;
  createdAt: number;
  lastMessageAt: number;
  status: SessionStatus;
  messageCount: number;
  /** Working dir the agent was spawned in. May be null for very old rows. */
  cwd?: string | null;
  /** Underlying agent SDK's session ID, set after the FIRST run completes
   *  (claude-agent-sdk session_id, codex's session UUID). Lets the dashboard
   *  surface a "Continue in CLI" affordance so the user can hop into the
   *  same conversation from their terminal (`claude --resume <id>`). Null
   *  for chats that have never produced a model response. */
  nativeSessionId?: string | null;
};

/** A saved working directory the user can quickly spawn a chat into. */
export type Project = {
  /** Display label (defaults to folder basename). 60-char max. */
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Pinned projects float to the top of the picker. */
  pinned: boolean;
  /** ms epoch when first added. */
  addedAt: number;
};

// Opaque message shape coming from the underlying agent SDK.
// The dashboard renders one row per AgentMessage. An assistant turn that
// contains both `thinking` + `text` + a `tool_use` will arrive as THREE
// separate AgentMessages so each block can render with its own UI affordance.
export type AgentMessage = {
  type:
    | "system"
    | "assistant"
    | "user"
    | "result"
    | "tool_use"
    | "tool_result"
    | "thinking"
    | "redacted_thinking"
    | "error"
    | string;
  // Original SDK message payload — kept as `unknown` to stay adapter-agnostic.
  raw: unknown;
  // Best-effort flat text extracted by the adapter for quick rendering.
  // Used by `assistant`, `user`, `result`, and as fallback prose.
  text?: string;
  // Reasoning content surfaced by extended thinking. Only set when
  // type === "thinking". `redacted_thinking` is a separate type with no body.
  thinking?: string;
  // Optional structured fields. Only set when type === "tool_use".
  tool?: { name: string; input?: unknown };
  // Only set when type === "tool_result".
  toolResult?: { output?: unknown; isError?: boolean };
  /** Images attached to a `user` message. Persisted so reloads / other
   *  devices see the same attachments the prompt was sent with. */
  images?: PromptImage[];
};

// ----- Client → Server commands -----
export type PocketAgentsCommand =
  | { type: "auth"; token: string; protocolVersion: number }
  | { type: "session.list" }
  | {
      type: "session.create";
      agent?: AgentName;
      title?: string;
      /** Override the default cwd (~) for this session only. */
      cwd?: string;
    }
  | { type: "session.resume"; sessionId: string }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.delete"; sessionId: string }
  | { type: "session.rename"; sessionId: string; title: string }
  | {
      type: "prompt";
      sessionId: string;
      text: string;
      /** Optional inline images pasted/attached by the user. Server forwards
       *  to the adapter as multimodal content. Claude only — Codex ignores. */
      images?: PromptImage[];
    }
  | { type: "projects.list" }
  | { type: "projects.add"; path: string; name?: string; pinned?: boolean }
  | { type: "projects.remove"; path: string }
  | { type: "projects.toggle_pin"; path: string }
  | { type: "fs.scan" }
  | { type: "ping" };

// ----- Server → Client events -----
export type PocketAgentsEvent =
  | {
      type: "auth.ok";
      protocolVersion: number;
      agent: AgentName[];
      serverVersion: string;
    }
  | { type: "auth.fail"; reason: string }
  | { type: "session.list"; sessions: SessionSummary[] }
  | { type: "session.created"; session: SessionSummary }
  | { type: "session.updated"; session: SessionSummary }
  | { type: "session.deleted"; sessionId: string }
  | {
      type: "session.history";
      sessionId: string;
      messages: AgentMessage[];
      status: SessionStatus;
      /** ms epoch when the in-flight run started. Only present when
       *  status === "running"; lets the dashboard resume a faithful
       *  elapsed-time counter instead of restarting from 0 on chat switch. */
      runStartedAt?: number | null;
    }
  | { type: "agent.message"; sessionId: string; message: AgentMessage }
  | {
      type: "agent.status";
      sessionId: string;
      status: SessionStatus;
      durationMs?: number;
      /** ms epoch when this run started. Set on the status=running event so
       *  the dashboard timer ticks from the true start rather than from
       *  whenever the client happened to receive the frame. */
      runStartedAt?: number | null;
    }
  | { type: "agent.error"; sessionId: string; error: string }
  | { type: "projects.list"; projects: Project[] }
  | { type: "projects.error"; reason: string }
  | { type: "fs.scan"; folders: DiscoveredFolder[] }
  | { type: "pong"; t: number };

/** A folder the server discovered on the laptop. Surfaced in the picker. */
export type DiscoveredFolder = {
  path: string;
  name: string;
  /** Parent dir for grouping, e.g. "~/Documents/GitHub". */
  parent: string;
  isGitRepo: boolean;
  mtimeMs: number;
};

// ----- Pairing payload (encoded in QR) -----
export type PairingPayload = {
  v: number; // PROTOCOL_VERSION
  url: string; // wss/https tunnel URL
  token: string; // bearer token for `auth` command
  name?: string; // optional friendly server name (e.g. "Nghia's MacBook")
};
