#!/usr/bin/env bun
import { startServer } from "./server.ts";
import { startTunnel } from "./tunnel.ts";
import { getLanIp } from "./net.ts";
import {
  buildPairingPayload,
  loadOrCreateServerName,
  loadOrCreateToken,
  pairingDeepLink,
  printPairingQR,
  rotateToken,
} from "./pair.ts";

const VERSION = "0.1.0";

const args = new Set(process.argv.slice(2));
const NO_TUNNEL = args.has("--no-tunnel") || !!process.env.AGENTDECK_NO_TUNNEL;
const SHOW_HELP = args.has("--help") || args.has("-h");
const ROTATE = args.has("--rotate-token");
const PORT = Number(process.env.AGENTDECK_PORT ?? 3737);

if (SHOW_HELP) {
  console.log(`AgentDeck CLI v${VERSION}

Usage:
  agentdeck                  Start server + Cloudflare tunnel, print QR
  agentdeck --no-tunnel      LAN-only mode (skip tunnel; QR uses local IP)
  agentdeck --rotate-token   Generate a fresh pairing token (invalidates old)
  agentdeck --help           Show this

Env:
  AGENTDECK_PORT       Server port (default: 3737)
  AGENTDECK_HOME       Config + db dir (default: ~/.agentdeck)
  AGENTDECK_NO_TUNNEL  Skip cloudflared

Docs: https://github.com/the-agents-work/agentdeck
`);
  process.exit(0);
}

const token = ROTATE ? rotateToken() : loadOrCreateToken();
const serverName = loadOrCreateServerName();

console.log(`AgentDeck v${VERSION}`);
console.log(`Server name: ${serverName}`);
console.log(`Config dir:  ${process.env.AGENTDECK_HOME ?? "~/.agentdeck"}`);
console.log("");

const server = startServer({ port: PORT, token, version: VERSION });
console.log(`Listening on ${server.url}`);

const lanIp = getLanIp();
const lanUrl = `http://${lanIp}:${server.port}`;

let publicUrl: string;
let stopTunnel: (() => Promise<void> | void) | null = null;
if (NO_TUNNEL) {
  publicUrl = lanUrl;
  console.log(`Tunnel: SKIPPED (--no-tunnel). Phone must be on same Wi-Fi as ${lanIp}.`);
} else {
  try {
    const t = await startTunnel({
      port: server.port,
      onStatus: (l) => console.log(l),
    });
    publicUrl = t.url;
    stopTunnel = t.stop;
    console.log(`Tunnel: ${publicUrl}`);
  } catch (err) {
    console.error("Tunnel failed:", err instanceof Error ? err.message : err);
    console.error(`Falling back to LAN mode at ${lanUrl}. Phone must be on the same Wi-Fi.`);
    publicUrl = lanUrl;
  }
}

const payload = buildPairingPayload({ url: publicUrl, token, name: serverName });
console.log("");
console.log("───── Scan with AgentDeck mobile app ─────");
printPairingQR(payload);
console.log(pairingDeepLink(payload));
console.log("──────────────────────────────────────────");
console.log("");
console.log("Token rotation: `agentdeck --rotate-token` (invalidates paired phones)");
console.log("Press Ctrl+C to stop.");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down...`);
  try {
    await stopTunnel?.();
  } catch {}
  try {
    server.stop();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
