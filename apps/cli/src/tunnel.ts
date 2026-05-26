// Wraps the `cloudflared` npm package: auto-downloads binary on first run,
// then runs `cloudflared tunnel --url http://localhost:<port>` and resolves
// the random *.trycloudflare.com URL via the Tunnel EventEmitter.
//
// Graceful fallback: if download fails (offline, etc) we surface a clear
// error so the user can pass --no-tunnel and pair over LAN instead.

import { existsSync } from "node:fs";
import { bin, install, Tunnel } from "cloudflared";

export type TunnelHandle = {
  url: string;
  stop: () => void;
};

export async function startTunnel(opts: {
  port: number;
  onStatus?: (line: string) => void;
  timeoutMs?: number;
}): Promise<TunnelHandle> {
  if (!existsSync(bin)) {
    opts.onStatus?.("Downloading cloudflared (~8MB, first run only)...");
    await install(bin);
  }

  // Use the static quick() factory — cloudflared 0.7+ requires this for
  // trycloudflare quick tunnels. The general tunnel() helper now defaults
  // to `tunnel run`, which requires an authenticated tunnel ID.
  const t: Tunnel = Tunnel.quick(`http://localhost:${opts.port}`);

  // NB: the wrapper's built-in "url" event matches the FIRST regex hit on
  // `https://[a-z0-9-]+\.trycloudflare\.com`, which incorrectly catches
  // `https://api.trycloudflare.com` (the cloudflared API endpoint) instead of
  // the quick tunnel URL like `https://rail-rrp-michigan-promotion.trycloudflare.com`.
  // We ignore that event and parse stderr ourselves with a stricter pattern
  // that requires at least one hyphen in the subdomain — every quick tunnel
  // hostname is multi-word (e.g. "rail-rrp-michigan-promotion").
  const QUICK_URL = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;

  let lastStderr = "";
  let resolved = false;

  const url = await new Promise<string>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      reject(new Error(`tunnel did not advertise a URL within ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (u: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(u);
    };

    t.on("stderr", (line: string) => {
      lastStderr = (lastStderr + line).slice(-2000);
      if (resolved) return;
      const m = line.match(QUICK_URL);
      if (m) finish(m[0]);
    });
    t.on("stdout", (line: string) => {
      if (resolved) return;
      const m = line.match(QUICK_URL);
      if (m) finish(m[0]);
    });

    t.once("error", (err) => {
      if (resolved) return;
      clearTimeout(timer);
      reject(err);
    });
    t.once("exit", (code) => {
      if (resolved) return;
      clearTimeout(timer);
      const hint = lastStderr.trim()
        ? `\ncloudflared stderr (tail):\n${lastStderr.trim()}`
        : "";
      reject(new Error(`cloudflared exited (code=${code}) before advertising a URL${hint}`));
    });
  });

  return {
    url,
    stop: () => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    },
  };
}
