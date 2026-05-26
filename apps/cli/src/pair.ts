import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import qrcode from "qrcode-terminal";
import type { PairingPayload } from "@agentdeck/protocol";
import { PROTOCOL_VERSION } from "@agentdeck/protocol";
import { TOKEN_PATH, SERVER_NAME_PATH, ensureConfigDir } from "./paths.ts";

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
  return `agentdeck://pair?${params.toString()}`;
}
