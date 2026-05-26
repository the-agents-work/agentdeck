#!/usr/bin/env bun
import qrcode from "qrcode-terminal";
import { startServer } from "./server.ts";
import { startTunnel } from "./tunnel.ts";
import { getLanIp } from "./net.ts";
import {
  loadOrCreateServerName,
  loadOrCreateToken,
  loadPin,
  rotateToken,
  savePin,
} from "./pair.ts";

const VERSION = "0.1.0";

const argv = process.argv.slice(2);
const args = new Set(argv);
const NO_TUNNEL = args.has("--no-tunnel") || !!process.env.AGENTDECK_NO_TUNNEL;
const SHOW_HELP = args.has("--help") || args.has("-h");
const ROTATE = args.has("--rotate-token");
const PORT = Number(process.env.AGENTDECK_PORT ?? 3737);

// One-shot PIN management commands. Run them then exit — never start the server.
const setPinIdx = argv.indexOf("--set-pin");
if (setPinIdx >= 0) {
  const newPin = argv[setPinIdx + 1];
  if (!newPin || newPin.length < 4 || newPin.length > 10) {
    console.error("Usage: agentdeck --set-pin <4-10 chars>");
    process.exit(2);
  }
  savePin(newPin);
  console.log("PIN saved to ~/.agentdeck/pin (mode 0600).");
  console.log("Next start of `agentdeck` will require this PIN after pairing.");
  process.exit(0);
}
if (args.has("--clear-pin")) {
  savePin("");
  console.log("PIN cleared. Dashboard no longer requires a PIN.");
  process.exit(0);
}

if (SHOW_HELP) {
  console.log(`AgentDeck CLI v${VERSION}

Usage:
  agentdeck                       Start server + Cloudflare tunnel, print dashboard URL
  agentdeck --no-tunnel           LAN-only mode (use laptop's LAN IP, no tunnel)
  agentdeck --rotate-token        Generate a fresh pairing token (invalidates old links)
  agentdeck --set-pin <4-10>      Save a PIN. Dashboard prompts for it after pairing.
  agentdeck --clear-pin           Remove the saved PIN.
  agentdeck --help                Show this

Env:
  AGENTDECK_PORT       Server port (default: 3737)
  AGENTDECK_HOME       Config + db dir (default: ~/.agentdeck)
  AGENTDECK_NO_TUNNEL  Skip cloudflared
  AGENTDECK_PIN        PIN value (overrides ~/.agentdeck/pin file)

Docs: https://github.com/the-agents-work/agentdeck
`);
  process.exit(0);
}

const token = ROTATE ? rotateToken() : loadOrCreateToken();
const serverName = loadOrCreateServerName();
const pin = loadPin();

console.log(`AgentDeck v${VERSION}`);
console.log(`Server name: ${serverName}`);
console.log(`Config dir:  ${process.env.AGENTDECK_HOME ?? "~/.agentdeck"}`);
console.log(`PIN gate:    ${pin ? "ENABLED (dashboard will prompt)" : "off (use --set-pin <pin> to enable)"}`);
console.log("");

const server = startServer({ port: PORT, token, pin, version: VERSION });
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

// One-shot tokenized dashboard URL. Open in any browser to pair this device;
// the page strips the token from the URL and stores it in localStorage so
// subsequent reloads stay paired without exposing the token in history.
const dashboardUrl = `${publicUrl}/?t=${encodeURIComponent(token)}`;

console.log("");
console.log("──────────────── Open this URL on any device ────────────────");
console.log("");
console.log(`  ${dashboardUrl}`);
console.log("");
console.log("  (Scan QR below from your phone to open in mobile browser)");
console.log("");
qrcode.generate(dashboardUrl, { small: true });
console.log("─────────────────────────────────────────────────────────────");
console.log("");
console.log("Token rotation: `agentdeck --rotate-token` (invalidates the link above)");
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
