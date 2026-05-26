# AgentDeck

> Pocket-sized remote control for coding agents. One command on your laptop, open a link on any device, chat with Claude Code from wherever you are.

```
┌──────────┐       Cloudflare       ┌──────────┐       AgentAdapter      ┌─────────────────┐
│  Phone   │ ─────── tunnel ──────▶ │  Laptop  │ ──────────────────────▶ │  Claude Code    │
│ (Browser)│         (WSS)          │  (Bun)   │                         │  Codex (soon)   │
└──────────┘                        └──────────┘                         └─────────────────┘
        open URL           persists sessions in            spawns @anthropic-ai/claude-agent-sdk
        once               ~/.agentdeck/agentdeck.db        with session resume
```

**Why?** Long agent runs feel terrible when you're chained to a terminal. AgentDeck lets you fire off a prompt, lock your phone, and come back when the work's done.

**No app to install.** The dashboard runs in any browser. Sessions persist on the laptop, so you can close the tab and re-open it later — chat history stays.

## Status

`v0.2.0` — Web dashboard + Claude Code adapter. Codex CLI adapter is stubbed and lands next.

## Quick start

```bash
git clone https://github.com/the-agents-work/agentdeck
cd agentdeck
npm install
bun apps/cli/src/index.ts
```

On first run, AgentDeck:

1. Downloads `cloudflared` (~8MB, once) and starts a free Cloudflare quick tunnel.
2. Prints a **tokenized dashboard URL** like `https://xxx-yyy-zzz.trycloudflare.com/?t=ABCD...`
3. Also prints a **QR code** of that URL.

**Open the URL on your phone** (paste, or scan the QR with your phone camera). The page strips the token from the URL and stores it in `localStorage` — subsequent visits stay paired, no token in browser history.

That's the whole flow. No native app, no Expo, no signup.

### CLI flags

| Flag | Effect |
|---|---|
| `--no-tunnel` | LAN-only mode. URL uses your laptop's LAN IP. Phone must be on the same Wi-Fi. |
| `--rotate-token` | Invalidates the current dashboard URL. All paired devices lose access. |
| `--help` | Show help. |

Env: `AGENTDECK_PORT` (default `3737`), `AGENTDECK_HOME` (default `~/.agentdeck`).

## How auth works

You don't need to configure Claude API keys. AgentDeck wraps `@anthropic-ai/claude-agent-sdk`, which inherits credentials in this order:

1. `ANTHROPIC_API_KEY` env var (pay-per-use API)
2. `~/.claude/credentials.json` from `claude login` (your Pro/Max subscription)

Most devs already have step 2 set up, so AgentDeck just works on your existing subscription.

## Architecture

```
agentdeck/
├── apps/
│   └── cli/                Bun server: WS + agent runner + static dashboard
│       ├── src/index.ts    Entrypoint: tunnel + URL printout
│       ├── src/server.ts   Bun.serve — serves /dashboard + /ws + /health
│       ├── src/runner.ts   Orchestrates an adapter run, persists messages
│       ├── src/store.ts    SQLite (bun:sqlite) — sessions + messages
│       ├── src/tunnel.ts   cloudflared wrapper (quick tunnel)
│       ├── src/net.ts      LAN IP detection for --no-tunnel mode
│       ├── src/pair.ts     token rotation + naming
│       └── static/dashboard.html   Single-file Preact SPA (no build step)
└── packages/
    ├── protocol/           Event types shared between server and dashboard
    └── adapters/           AgentAdapter interface + ClaudeCodeAdapter
```

### Wire protocol

All traffic is JSON over a single WebSocket connection at `/ws`. After connect, the client must send:

```jsonc
{ "type": "auth", "token": "<from URL>", "protocolVersion": 1 }
```

Server responds with `auth.ok` (or `auth.fail`). Subsequent commands: `session.list`, `session.create`, `session.resume`, `prompt`, `session.stop`. Server pushes `agent.message`, `agent.status`, `agent.error` events as they happen. Full schema in [`packages/protocol/src/index.ts`](packages/protocol/src/index.ts).

### Session resume

Each conversation has two IDs:

- **AgentDeck session id** (UUID) — the unit of conversation the dashboard sees. Stable across agents.
- **Native session id** (Claude SDK's `session_id`) — tracked per turn so the adapter passes `resume: <id>` on the next prompt, keeping the conversation context server-side.

When the browser reconnects, it requests `session.resume`; server sends the full message history from SQLite, then live-streams new events. You can close the tab and come back — context is intact.

## Adding a new adapter (Codex, Aider, ...)

Implement [`AgentAdapter`](packages/adapters/src/types.ts):

```ts
import type { AgentAdapter, AdapterRunOptions, AdapterRunResult } from "./types";

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex" as const;

  async *run(opts: AdapterRunOptions): AsyncGenerator<AgentMessage, AdapterRunResult> {
    // Spawn `codex` subprocess (or use its SDK), stream events, yield AgentMessage.
    // Track the native session id you receive so callers can resume next turn.
  }
}
```

Then register it in `packages/adapters/src/index.ts`.

## Security notes

- The pairing token is the only auth between browser and laptop. The dashboard URL contains it as `?t=...` once, after which it lives in `localStorage` on the device.
- `--rotate-token` invalidates the existing token. Use it if a link leaked.
- The Cloudflare tunnel is publicly reachable; WS auth is what keeps strangers out. Treat the dashboard URL like a password.
- Database (`~/.agentdeck/agentdeck.db`) stores conversation history in plaintext. Don't share.

## Why a hosted browser instead of a native app?

The earliest version of AgentDeck was an Expo React Native app. We dropped it because:

1. **Zero install** — anyone with a browser can use it instantly.
2. **Cross-device** — same link works on phone, tablet, or another laptop.
3. **No store gatekeeping** — Expo Go's SDK pinning forced the project to lag two SDKs behind.
4. **Smaller surface area** — one HTML file vs. a whole Metro/Babel/EAS pipeline.

The native app may come back later as a thin shell around the same web view, mainly to enable **push notifications** when an agent run finishes.

## Roadmap

- [x] Claude Code adapter
- [x] Web dashboard
- [x] Cloudflare quick tunnel built-in
- [ ] Codex CLI adapter
- [ ] PWA install + push notifications on `agent.done`
- [ ] Tool permission prompts surfaced to the dashboard (approve/deny per tool call)
- [ ] BYO custom domain (named Cloudflare tunnel, not random trycloudflare URL)
- [ ] Markdown rendering for assistant messages (currently shown as plaintext)

## License

MIT. See [LICENSE](LICENSE).
