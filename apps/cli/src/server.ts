import type { ServerWebSocket } from "bun";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  PocketAgentsCommand,
  PocketAgentsEvent,
  AgentName,
} from "@pocket-agents/protocol";
import { PROTOCOL_VERSION } from "@pocket-agents/protocol";
import { SessionStore } from "./store.ts";
import { Runner } from "./runner.ts";

const STATIC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../static",
);
const DASHBOARD_FILE = resolve(STATIC_DIR, "dashboard.html");

// Where agents spawn by default for fresh sessions. We pick $HOME (not the
// CLI's cwd, which is wherever the user happened to run `bun ...` from) so the
// agent can freely `git clone`, scaffold projects, and explore without being
// scoped to the pocket-agents repo itself. Override with POCKETAGENTS_DEFAULT_CWD.
const DEFAULT_SESSION_CWD = process.env.POCKETAGENTS_DEFAULT_CWD || homedir();
const SUPPORTED_AGENTS: AgentName[] = ["claude", "codex"];

// How many wrong PIN attempts per WS connection before we drop the socket.
// Don't make it too generous — token leak + bruteforce of a short PIN otherwise
// becomes trivial. 5 is enough for fat-finger users without enabling 10k-try
// scripts (they'd have to keep re-connecting + re-authing with the token).
const MAX_PIN_ATTEMPTS = 5;

type ConnData = {
  authed: boolean;
  pinVerified: boolean;
  pinAttempts: number;
  remote: string;
};

export type ServerHandle = {
  port: number;
  stop: () => void;
  url: string;
};

export function startServer(opts: {
  port: number;
  token: string;
  /** Optional second-factor PIN. If null/undefined, the PIN gate is disabled. */
  pin: string | null;
  version: string;
}): ServerHandle {
  const pinRequired = !!opts.pin;
  const store = new SessionStore();
  const runner = new Runner(store);

  // Fan out runner events to all authed sockets
  const sockets = new Set<ServerWebSocket<ConnData>>();
  runner.subscribe((event) => {
    let wire: PocketAgentsEvent;
    if (event.type === "message") {
      wire = {
        type: "agent.message",
        sessionId: event.sessionId,
        message: event.message,
      };
    } else if (event.type === "status") {
      wire = {
        type: "agent.status",
        sessionId: event.sessionId,
        status: event.status,
        durationMs: event.durationMs,
      };
    } else {
      wire = {
        type: "agent.error",
        sessionId: event.sessionId,
        error: event.error,
      };
    }
    const data = JSON.stringify(wire);
    for (const ws of sockets) {
      // Only fan out to fully-authenticated sockets. A PIN-gated socket has
      // already been auth'd at the token layer; we still don't want to leak
      // session events to a window stuck on the PIN screen of a stolen link.
      if (ws.data.authed && (!pinRequired || ws.data.pinVerified)) {
        ws.send(data);
      }
    }
  });

  const server = Bun.serve<ConnData, never>({
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response("ok");
      }

      // WebSocket upgrade — distinct path so we don't conflict with the
      // dashboard served at "/".
      if (url.pathname === "/ws") {
        const ok = srv.upgrade(req, {
          data: {
            authed: false,
            pinVerified: false,
            pinAttempts: 0,
            remote: req.headers.get("x-forwarded-for") ?? "?",
          },
        });
        if (ok) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }

      // Dashboard SPA. Served at /; deep links are SPA-internal so we never
      // need a separate route. ?t=TOKEN is read by the client-side JS.
      if (url.pathname === "/" || url.pathname === "/dashboard.html") {
        const file = Bun.file(DASHBOARD_FILE);
        return new Response(file, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
        let cmd: PocketAgentsCommand;
        try {
          cmd = JSON.parse(
            typeof raw === "string" ? raw : raw.toString(),
          ) as PocketAgentsCommand;
        } catch {
          return send(ws, { type: "auth.fail", reason: "invalid json" });
        }

        // Gate everything behind auth except the auth handshake itself
        if (!ws.data.authed) {
          if (cmd.type !== "auth") {
            return send(ws, { type: "auth.fail", reason: "not authed" });
          }
          if (!constantTimeEqual(cmd.token, opts.token)) {
            return send(ws, { type: "auth.fail", reason: "bad token" });
          }
          if (cmd.protocolVersion !== PROTOCOL_VERSION) {
            return send(ws, {
              type: "auth.fail",
              reason: `protocol mismatch (server v${PROTOCOL_VERSION}, client v${cmd.protocolVersion})`,
            });
          }
          ws.data.authed = true;
          return send(ws, {
            type: "auth.ok",
            protocolVersion: PROTOCOL_VERSION,
            agent: SUPPORTED_AGENTS,
            serverVersion: opts.version,
            pinRequired,
          });
        }

        // PIN gate — runs AFTER token auth, BEFORE any session/prompt command.
        if (pinRequired && !ws.data.pinVerified) {
          if (cmd.type !== "pin.verify") {
            return send(ws, {
              type: "pin.fail",
              reason: "pin required",
              attemptsRemaining: MAX_PIN_ATTEMPTS - ws.data.pinAttempts,
            });
          }
          ws.data.pinAttempts += 1;
          if (!constantTimeEqual(cmd.pin, opts.pin ?? "")) {
            const remaining = MAX_PIN_ATTEMPTS - ws.data.pinAttempts;
            if (remaining <= 0) {
              send(ws, {
                type: "pin.fail",
                reason: "too many attempts",
                attemptsRemaining: 0,
              });
              ws.close(4003, "pin attempts exhausted");
              return;
            }
            return send(ws, {
              type: "pin.fail",
              reason: "wrong pin",
              attemptsRemaining: remaining,
            });
          }
          ws.data.pinVerified = true;
          return send(ws, { type: "pin.ok" });
        }

        switch (cmd.type) {
          case "ping":
            return send(ws, { type: "pong", t: Date.now() });

          case "session.list":
            return send(ws, {
              type: "session.list",
              sessions: store.listSessions(),
            });

          case "session.create": {
            const session = store.createSession({
              agent: isSupportedAgent(cmd.agent) ? cmd.agent : "claude",
              title: cmd.title,
              cwd: DEFAULT_SESSION_CWD,
            });
            return send(ws, { type: "session.created", session });
          }

          case "session.resume": {
            const session = store.getSession(cmd.sessionId);
            if (!session) {
              return send(ws, {
                type: "agent.error",
                sessionId: cmd.sessionId,
                error: "session not found",
              });
            }
            return send(ws, {
              type: "session.history",
              sessionId: session.id,
              messages: store.getMessages(session.id),
              status: session.status,
            });
          }

          case "session.delete":
            store.deleteSession(cmd.sessionId);
            return send(ws, {
              type: "session.deleted",
              sessionId: cmd.sessionId,
            });

          case "session.stop": {
            const stopped = runner.stop(cmd.sessionId);
            if (!stopped) {
              return send(ws, {
                type: "agent.error",
                sessionId: cmd.sessionId,
                error: "session not running",
              });
            }
            return;
          }

          case "prompt":
            // Fire-and-forget. Results stream via runner.subscribe() fanout above.
            runner.run(cmd.sessionId, cmd.text).catch((err) => {
              const error = err instanceof Error ? err.message : String(err);
              send(ws, {
                type: "agent.error",
                sessionId: cmd.sessionId,
                error,
              });
            });
            return;

          case "auth":
            // Already authed — ignore re-auth
            return;

          case "pin.verify":
            // Already PIN-verified above. Silent ignore is safer than echo —
            // a malicious page can't probe the PIN by sending it repeatedly.
            return;
        }
      },
    },
  });

  return {
    port: opts.port,
    url: `http://localhost:${opts.port}`,
    stop: () => server.stop(true),
  };
}

/**
 * Constant-time string comparison. Don't use === on secrets — node JS string
 * compare short-circuits on first mismatch, which leaks length and prefix
 * information through timing. Always-O(len) loop avoids that.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function send(ws: ServerWebSocket<ConnData>, event: PocketAgentsEvent): void {
  ws.send(JSON.stringify(event));
}

function isSupportedAgent(agent: AgentName | undefined): agent is AgentName {
  return !!agent && SUPPORTED_AGENTS.includes(agent);
}
