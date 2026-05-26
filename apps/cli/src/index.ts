// Shebang is added at build time via `bun build --banner` so the bundled
// dist/index.js works as a CLI binary. We omit it from the TS source so
// development runs (`bun src/index.ts`) don't trip on a stale duplicate
// shebang after re-bundling.
import { randomInt } from "node:crypto";
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

/**
 * Generate a cryptographically-random 6-digit PIN. We use randomInt() from
 * node:crypto (CSPRNG-backed) rather than Math.random() which is predictable.
 * 6 digits = 10^6 = 1M possibilities; combined with the 5-attempt server lockout
 * that's ~200k expected guesses to break — orders of magnitude beyond what
 * a casual leak-then-poke attack would attempt.
 */
function generateRandomPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const VERSION = "0.1.0";

const argv = process.argv.slice(2);
const args = new Set(argv);
const NO_TUNNEL = args.has("--no-tunnel") || !!process.env.POCKETAGENTS_NO_TUNNEL;
const SHOW_HELP = args.has("--help") || args.has("-h");
const ROTATE = args.has("--rotate-token");
const PORT = Number(process.env.POCKETAGENTS_PORT ?? 3737);

// One-shot PIN management commands. Run them then exit — never start the server.
const setPinIdx = argv.indexOf("--set-pin");
if (setPinIdx >= 0) {
  const newPin = argv[setPinIdx + 1];
  if (!newPin || newPin.length < 4 || newPin.length > 10) {
    console.error("Usage: pocket-agents --set-pin <4-10 chars>");
    process.exit(2);
  }
  savePin(newPin);
  console.log("PIN saved to ~/.pocket-agents/pin (mode 0600).");
  console.log("Next start of `pocket-agents` will require this PIN after pairing.");
  process.exit(0);
}
if (args.has("--clear-pin")) {
  savePin("");
  console.log("PIN cleared. Dashboard no longer requires a PIN.");
  process.exit(0);
}
if (args.has("--gen-pin")) {
  const newPin = generateRandomPin();
  savePin(newPin);
  console.log("");
  console.log("───── New random PIN ─────");
  console.log("");
  console.log(`  ${newPin}`);
  console.log("");
  console.log("──────────────────────────");
  console.log("");
  console.log("Saved to ~/.pocket-agents/pin (mode 0600).");
  console.log("Remember this PIN — it won't be printed again unless you rotate.");
  process.exit(0);
}

if (SHOW_HELP) {
  console.log(`Pocket Agents CLI v${VERSION}

Usage:
  pocket-agents                   Start server + Cloudflare tunnel, print dashboard URL
  pocket-agents --no-tunnel           LAN-only mode (use laptop's LAN IP, no tunnel)
  pocket-agents --rotate-token        Generate a fresh pairing token (invalidates old links)
  pocket-agents --gen-pin             Generate a random 6-digit PIN and print it once.
  pocket-agents --set-pin <4-10>      Save a PIN you choose. Dashboard prompts after pairing.
  pocket-agents --clear-pin           Remove the saved PIN.
  pocket-agents --help                Show this

Env:
  POCKETAGENTS_PORT       Server port (default: 3737)
  POCKETAGENTS_HOME       Config + db dir (default: ~/.pocket-agents)
  POCKETAGENTS_NO_TUNNEL  Skip cloudflared
  POCKETAGENTS_PIN        PIN value (overrides ~/.pocket-agents/pin file)

Docs: https://github.com/the-agents-work/pocket-agents
`);
  process.exit(0);
}

const token = ROTATE ? rotateToken() : loadOrCreateToken();
const serverName = loadOrCreateServerName();
const pin = loadPin();

console.log(`Pocket Agents v${VERSION}`);
console.log(`Server name: ${serverName}`);
console.log(`Config dir:  ${process.env.POCKETAGENTS_HOME ?? "~/.pocket-agents"}`);
console.log(
  `PIN gate:    ${pin ? "ENABLED (dashboard will prompt)" : "off (use --gen-pin or --set-pin to enable)"}`,
);
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
