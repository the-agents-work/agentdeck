// Shebang is added at build time via `bun build --banner` so the bundled
// dist/index.js works as a CLI binary. We omit it from the TS source so
// development runs (`bun src/index.ts`) don't trip on a stale duplicate
// shebang after re-bundling.
import qrcode from "qrcode-terminal";
import { startServer } from "./server.ts";
import { startTunnel } from "./tunnel.ts";
import { getLanIp } from "./net.ts";
import {
  loadOrCreateServerName,
  loadOrCreateToken,
  rotateToken,
} from "./pair.ts";

const VERSION = "0.1.0";

const argv = process.argv.slice(2);
const args = new Set(argv);
const NO_TUNNEL = args.has("--no-tunnel") || !!process.env.POCKETAGENTS_NO_TUNNEL;
const SHOW_HELP = args.has("--help") || args.has("-h");
const ROTATE = args.has("--rotate-token");
const PORT = Number(process.env.POCKETAGENTS_PORT ?? 3737);

if (SHOW_HELP) {
  console.log(`Pocket Agents CLI v${VERSION}

Usage:
  pocket-agents                       Start server + Cloudflare tunnel, print dashboard URL
  pocket-agents --no-tunnel           LAN-only mode (use laptop's LAN IP, no tunnel)
  pocket-agents --rotate-token        Generate a fresh pairing token (invalidates old links)
  pocket-agents --help                Show this

Env:
  POCKETAGENTS_PORT       Server port (default: 3737)
  POCKETAGENTS_HOME       Config + db dir (default: ~/.pocket-agents)
  POCKETAGENTS_NO_TUNNEL  Skip cloudflared

Docs: https://github.com/the-agents-work/pocket-agents
`);
  process.exit(0);
}

const token = ROTATE ? rotateToken() : loadOrCreateToken();
const serverName = loadOrCreateServerName();

console.log(`Pocket Agents v${VERSION}`);
console.log(`Server name: ${serverName}`);
console.log(`Config dir:  ${process.env.POCKETAGENTS_HOME ?? "~/.pocket-agents"}`);
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

// One-shot tokenized dashboard URLs. Open in any browser to pair this device;
// the page strips the token from the URL and stores it in localStorage so
// subsequent reloads stay paired without exposing the token in history.
const tokenParam = `?t=${encodeURIComponent(token)}`;
const dashboardUrl = `${publicUrl}/${tokenParam}`;
const localUrl = `http://localhost:${server.port}/${tokenParam}`;

console.log("");
console.log("──────────────── Open this URL on any device ────────────────");
console.log("");
console.log(`  Local   ${localUrl}`);
console.log(`  Tunnel  ${dashboardUrl}`);
console.log("");
console.log("  (Scan QR below from your phone to open in mobile browser)");
console.log("");
qrcode.generate(dashboardUrl, { small: true });
console.log("─────────────────────────────────────────────────────────────");
console.log("");
console.log("Token rotation: `pocket-agents --rotate-token` (invalidates the link above)");
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
