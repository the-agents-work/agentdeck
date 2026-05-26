import type { ServerWebSocket } from "bun";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentDeckCommand, AgentDeckEvent } from "@agentdeck/protocol";
import { PROTOCOL_VERSION } from "@agentdeck/protocol";
import { SessionStore } from "./store.ts";
import { Runner } from "./runner.ts";

const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../static");
const DASHBOARD_FILE = resolve(STATIC_DIR, "dashboard.html");

// Where Claude spawns by default for fresh sessions. We pick $HOME (not the
// CLI's cwd, which is wherever the user happened to run `bun ...` from) so the
// agent can freely `git clone`, scaffold projects, and explore without being
// scoped to the agentdeck repo itself. Override with AGENTDECK_DEFAULT_CWD.
const DEFAULT_SESSION_CWD = process.env.AGENTDECK_DEFAULT_CWD || homedir();

type ConnData = { authed: boolean; remote: string };

export type ServerHandle = {
  port: number;
  stop: () => void;
  url: string;
};

export function startServer(opts: {
  port: number;
  token: string;
  version: string;
}): ServerHandle {
  const store = new SessionStore();
  const runner = new Runner(store);

  // Fan out runner events to all authed sockets
  const sockets = new Set<ServerWebSocket<ConnData>>();
  runner.subscribe((event) => {
    let wire: AgentDeckEvent;
    if (event.type === "message") {
      wire = { type: "agent.message", sessionId: event.sessionId, message: event.message };
    } else if (event.type === "status") {
      wire = {
        type: "agent.status",
        sessionId: event.sessionId,
        status: event.status,
        durationMs: event.durationMs,
      };
    } else {
      wire = { type: "agent.error", sessionId: event.sessionId, error: event.error };
    }
    const data = JSON.stringify(wire);
    for (const ws of sockets) {
      if (ws.data.authed) ws.send(data);
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
          data: { authed: false, remote: req.headers.get("x-forwarded-for") ?? "?" },
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
        let cmd: AgentDeckCommand;
        try {
          cmd = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as AgentDeckCommand;
        } catch {
          return send(ws, { type: "auth.fail", reason: "invalid json" });
        }

        // Gate everything behind auth except the auth handshake itself
        if (!ws.data.authed) {
          if (cmd.type !== "auth") {
            return send(ws, { type: "auth.fail", reason: "not authed" });
          }
          if (cmd.token !== opts.token) {
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
            agent: ["claude"],
            serverVersion: opts.version,
          });
        }

        switch (cmd.type) {
          case "ping":
            return send(ws, { type: "pong", t: Date.now() });

          case "session.list":
            return send(ws, { type: "session.list", sessions: store.listSessions() });

          case "session.create": {
            const session = store.createSession({
              agent: cmd.agent ?? "claude",
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
            return send(ws, { type: "session.deleted", sessionId: cmd.sessionId });

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
              send(ws, { type: "agent.error", sessionId: cmd.sessionId, error });
            });
            return;

          case "auth":
            // Already authed — ignore re-auth
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

function send(ws: ServerWebSocket<ConnData>, event: AgentDeckEvent): void {
  ws.send(JSON.stringify(event));
}
