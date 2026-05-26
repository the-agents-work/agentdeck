import type { ServerWebSocket } from "bun";
import type { AgentDeckCommand, AgentDeckEvent } from "@agentdeck/protocol";
import { PROTOCOL_VERSION } from "@agentdeck/protocol";
import { SessionStore } from "./store.ts";
import { Runner } from "./runner.ts";

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
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response("ok");
      }
      if (url.pathname === "/" || url.pathname === "/ws") {
        const ok = srv.upgrade(req, {
          data: { authed: false, remote: req.headers.get("x-forwarded-for") ?? "?" },
        });
        if (ok) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      return new Response("AgentDeck CLI is running", { status: 200 });
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
