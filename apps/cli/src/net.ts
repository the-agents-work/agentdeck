import { networkInterfaces } from "node:os";

/**
 * Returns the first non-loopback IPv4 address of the host, e.g. "192.168.1.62".
 * Falls back to "localhost" if no LAN interface is found (e.g. machine offline).
 *
 * Why: when running in --no-tunnel mode, the pairing QR must encode a URL the
 * PHONE can reach — not the laptop's own `localhost`.
 */
export function getLanIp(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return "localhost";
}
