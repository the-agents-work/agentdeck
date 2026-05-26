export const PROTOCOL_VERSION = 1;

export type AgentName = "claude" | "codex";

export type SessionStatus = "idle" | "running" | "error" | "done";

export type SessionSummary = {
  id: string;
  title: string;
  agent: AgentName;
  createdAt: number;
  lastMessageAt: number;
  status: SessionStatus;
  messageCount: number;
};

// Opaque message shape coming from the underlying agent SDK.
// We pass it through to the mobile client; the client renders by `subtype`.
export type AgentMessage = {
  type: "system" | "assistant" | "user" | "result" | "tool_use" | "tool_result" | string;
  // Original SDK message payload — kept as `unknown` to stay adapter-agnostic.
  raw: unknown;
  // Best-effort flat text extracted by the adapter for quick rendering.
  text?: string;
  // Optional structured fields the mobile UI may use.
  tool?: { name: string; input?: unknown };
  toolResult?: { output?: unknown; isError?: boolean };
};

// ----- Client → Server commands -----
export type AgentDeckCommand =
  | { type: "auth"; token: string; protocolVersion: number }
  | { type: "pin.verify"; pin: string }
  | { type: "session.list" }
  | { type: "session.create"; agent?: AgentName; title?: string }
  | { type: "session.resume"; sessionId: string }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.delete"; sessionId: string }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "ping" };

// ----- Server → Client events -----
export type AgentDeckEvent =
  | {
      type: "auth.ok";
      protocolVersion: number;
      agent: AgentName[];
      serverVersion: string;
      /** If true, the client must send `pin.verify` before anything else. */
      pinRequired: boolean;
    }
  | { type: "auth.fail"; reason: string }
  | { type: "pin.ok" }
  | { type: "pin.fail"; reason: string; attemptsRemaining: number }
  | { type: "session.list"; sessions: SessionSummary[] }
  | { type: "session.created"; session: SessionSummary }
  | { type: "session.deleted"; sessionId: string }
  | {
      type: "session.history";
      sessionId: string;
      messages: AgentMessage[];
      status: SessionStatus;
    }
  | { type: "agent.message"; sessionId: string; message: AgentMessage }
  | { type: "agent.status"; sessionId: string; status: SessionStatus; durationMs?: number }
  | { type: "agent.error"; sessionId: string; error: string }
  | { type: "pong"; t: number };

// ----- Pairing payload (encoded in QR) -----
export type PairingPayload = {
  v: number; // PROTOCOL_VERSION
  url: string; // wss/https tunnel URL
  token: string; // bearer token for `auth` command
  name?: string; // optional friendly server name (e.g. "Nghia's MacBook")
};
