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
import { ProjectStore } from "./projects.ts";
import { scanFolders } from "./fsscan.ts";

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

type ConnData = {
  authed: boolean;
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
  version: string;
}): ServerHandle {
  const store = new SessionStore();
  const projects = new ProjectStore();
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
        runStartedAt: event.runStartedAt,
      };
    } else if (event.type === "session_updated") {
      wire = { type: "session.updated", session: event.session };
    } else {
      wire = {
        type: "agent.error",
        sessionId: event.sessionId,
        error: event.error,
      };
    }
    const data = JSON.stringify(wire);
    for (const ws of sockets) {
      if (ws.data.authed) {
        ws.send(data);
      }
    }
  });

  // Bun.serve throws EADDRINUSE if `opts.port` is busy. Rather than crashing
  // (and forcing the user to either find + kill the offender or rerun with a
  // different POCKETAGENTS_PORT), we retry once on port 0 which tells the OS
  // to pick any free port. The chosen port is exposed in the returned object
  // so callers (tunnel, dashboard URL printer) use the actual value, not the
  // wished-for one. Killing other processes was considered too dangerous —
  // someone's terminal or unrelated app might be holding 3737 on purpose.
  let server: ReturnType<typeof Bun.serve<ConnData, never>>;
  try {
    server = Bun.serve<ConnData, never>(buildServeArgs(opts.port));
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code !== "EADDRINUSE") throw err;
    console.error(
      `Port ${opts.port} is already in use. Picking a free port instead — set POCKETAGENTS_PORT to a specific value if you want a stable one.`,
    );
    server = Bun.serve<ConnData, never>(buildServeArgs(0));
  }

  function buildServeArgs(
    port: number,
  ): Parameters<typeof Bun.serve<ConnData, never>>[0] {
    return {
    port,
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
          });
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
            // cwd resolution: explicit per-session > AGENTDECK default > homedir.
            // We don't trust the client blindly; a non-existent path falls back
            // to the default so the agent doesn't refuse to spawn.
            const wantedCwd = (cmd.cwd ?? "").trim();
            const cwd = wantedCwd || DEFAULT_SESSION_CWD;
            const session = store.createSession({
              agent: isSupportedAgent(cmd.agent) ? cmd.agent : "claude",
              title: cmd.title,
              cwd,
            });
            return send(ws, { type: "session.created", session });
          }

          case "projects.list":
            return send(ws, {
              type: "projects.list",
              projects: projects.list(),
            });

          case "projects.add": {
            const result = projects.add({
              path: cmd.path,
              name: cmd.name,
              pinned: cmd.pinned,
            });
            if (!result.ok) {
              return send(ws, { type: "projects.error", reason: result.error });
            }
            return send(ws, {
              type: "projects.list",
              projects: projects.list(),
            });
          }

          case "projects.remove":
            projects.remove(cmd.path);
            return send(ws, {
              type: "projects.list",
              projects: projects.list(),
            });

          case "projects.toggle_pin":
            projects.togglePin(cmd.path);
            return send(ws, {
              type: "projects.list",
              projects: projects.list(),
            });

          case "fs.scan": {
            // Synchronous scan — bounded by MAX_RESULTS in fsscan.ts so this
            // shouldn't block more than a few ms. If a user has thousands of
            // dotted dirs at home, we'd want to move to worker_threads, but
            // for now keep it inline for simplicity.
            return send(ws, {
              type: "fs.scan",
              folders: scanFolders(),
            });
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
              runStartedAt:
                session.status === "running"
                  ? runner.getRunStartedAt(session.id)
                  : null,
            });
          }

          case "session.delete": {
            store.deleteSession(cmd.sessionId);
            // Broadcast so other devices (phone + laptop browser) drop the
            // row immediately instead of falling out of sync until reload.
            const wire = JSON.stringify({
              type: "session.deleted",
              sessionId: cmd.sessionId,
            });
            for (const s of sockets) {
              if (s.data.authed) {
                s.send(wire);
              }
            }
            return;
          }

          case "session.rename": {
            const title = (cmd.title ?? "").trim();
            if (!title) {
              return send(ws, {
                type: "agent.error",
                sessionId: cmd.sessionId,
                error: "title is empty",
              });
            }
            // Cap length to keep sidebar layout sane. Matches deriveTitle().
            const capped = title.length > 80 ? title.slice(0, 80) : title;
            store.setTitle(cmd.sessionId, capped);
            const summary = store.getSummary(cmd.sessionId);
            if (!summary) {
              return send(ws, {
                type: "agent.error",
                sessionId: cmd.sessionId,
                error: "session not found",
              });
            }
            const wire = JSON.stringify({ type: "session.updated", session: summary });
            for (const s of sockets) {
              if (s.data.authed) {
                s.send(wire);
              }
            }
            return;
          }

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

          case "prompt": {
            // Defensive caps so a misbehaving / malicious client can't push
            // megabytes of base64 PNG through the WS and OOM the laptop.
            // 5 images per turn, 5MB each — generous for screenshots,
            // tight enough to flag accidental whole-screen paste.
            const MAX_IMAGES = 5;
            const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
            const images = (cmd.images ?? []).slice(0, MAX_IMAGES).filter((im) => {
              // base64 is 4/3 the byte size — approx is fine here.
              const approxBytes = (im.data_base64?.length ?? 0) * 0.75;
              return im.data_base64 && approxBytes <= MAX_BYTES_PER_IMAGE;
            });
            // Fire-and-forget. Results stream via runner.subscribe() fanout above.
            runner.run(cmd.sessionId, cmd.text, images).catch((err) => {
              const error = err instanceof Error ? err.message : String(err);
              send(ws, {
                type: "agent.error",
                sessionId: cmd.sessionId,
                error,
              });
            });
            return;
          }

          case "auth":
            // Already authed — ignore re-auth
            return;
        }
      },
    },
    };
  }

  // server.port reflects what we actually bound to. When port=0 the OS picks,
  // and Bun exposes the chosen number here. Everything downstream (tunnel,
  // QR, dashboard URL) reads from this so the wished-for opts.port never
  // gets used after the bind. Cast: Bun's types mark port as optional even
  // though it's always set after a successful bind.
  const boundPort = server.port ?? opts.port;
  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
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
