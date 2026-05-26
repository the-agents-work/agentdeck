import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import qrcode from "qrcode-terminal";
import type { PairingPayload } from "@pocket-agents/protocol";
import { PROTOCOL_VERSION } from "@pocket-agents/protocol";
import { TOKEN_PATH, SERVER_NAME_PATH, PIN_PATH, ensureConfigDir } from "./paths.ts";

export function loadOrCreateToken(): string {
  ensureConfigDir();
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

export function loadOrCreateServerName(): string {
  ensureConfigDir();
  if (existsSync(SERVER_NAME_PATH)) {
    return readFileSync(SERVER_NAME_PATH, "utf8").trim();
  }
  const name = hostname();
  writeFileSync(SERVER_NAME_PATH, name);
  return name;
}

export function rotateToken(): string {
  ensureConfigDir();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

/**
 * Load the optional second-factor PIN. Resolution order:
 *   1. `POCKETAGENTS_PIN` env var (wins, useful for tmux/launchd)
 *   2. `~/.pocket-agents/pin` file (created by user with `pocket-agents --set-pin <pin>`)
 *   3. null — no PIN gate
 *
 * PINs are stored in plaintext (mode 0600). The token + tunnel HTTPS already
 * provide the primary auth; the PIN is a leak mitigation, not a crypto secret.
 */
export function loadPin(): string | null {
  const envPin = process.env.POCKETAGENTS_PIN?.trim();
  if (envPin) return envPin;
  if (!existsSync(PIN_PATH)) return null;
  const fromFile = readFileSync(PIN_PATH, "utf8").trim();
  return fromFile.length ? fromFile : null;
}

/** Persist a PIN (4–10 chars). Pass empty string to clear. */
export function savePin(pin: string): void {
  ensureConfigDir();
  if (!pin) {
    try {
      // Best-effort delete; missing file is fine.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").unlinkSync(PIN_PATH);
    } catch {
      /* ignore */
    }
    return;
  }
  writeFileSync(PIN_PATH, pin, { mode: 0o600 });
}

export function buildPairingPayload(opts: {
  url: string;
  token: string;
  name?: string;
}): PairingPayload {
  return {
    v: PROTOCOL_VERSION,
    url: opts.url,
    token: opts.token,
    name: opts.name,
  };
}

export function printPairingQR(payload: PairingPayload): void {
  const json = JSON.stringify(payload);
  qrcode.generate(json, { small: true });
}

export function pairingDeepLink(payload: PairingPayload): string {
  const params = new URLSearchParams({
    url: payload.url,
    token: payload.token,
    v: String(payload.v),
  });
  if (payload.name) params.set("name", payload.name);
  return `pocketagents://pair?${params.toString()}`;
}
