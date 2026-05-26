# AgentDeck

> Pocket-sized remote control for coding agents. Pair your phone to Claude Code (and friends) running on your laptop, chat from anywhere, stop staring at the terminal.

```
┌──────────┐       Cloudflare       ┌──────────┐       AgentAdapter      ┌─────────────────┐
│  Phone   │ ─────── tunnel ──────▶ │  Laptop  │ ──────────────────────▶ │  Claude Code    │
│ (Expo RN)│         (WSS)          │  (Bun)   │                         │  Codex (soon)   │
└──────────┘                        └──────────┘                         └─────────────────┘
        scan QR              persists sessions in            spawns @anthropic-ai/claude-agent-sdk
        once                 ~/.agentdeck/agentdeck.db        with session resume
```

**Why?** Long agent runs feel terrible when you're chained to a terminal. AgentDeck lets you fire off a prompt, lock your phone, and come back when the work's done.

## Status

`v0.1.0` — Claude Code adapter only. Codex CLI adapter is stubbed and lands next.

## Quick start (laptop)

```bash
# In the agentdeck repo:
npm install
bun apps/cli/src/index.ts
```

On first run, AgentDeck:

1. Downloads the `cloudflared` binary (~8MB, once).
2. Starts a Cloudflare tunnel and prints a QR code.
3. Scan with the AgentDeck mobile app.

Subsequent runs reuse the cached binary and your local pairing token (stored at `~/.agentdeck/token`, mode 0600).

### CLI flags

| Flag | Effect |
|---|---|
| `--no-tunnel` | LAN-only mode. QR uses `http://localhost:PORT`, phone must be on same Wi-Fi. |
| `--rotate-token` | Generates a fresh pairing token. Existing paired phones must re-scan. |
| `--help` | Show help. |

Env: `AGENTDECK_PORT` (default `3737`), `AGENTDECK_HOME` (default `~/.agentdeck`).

## Quick start (mobile)

```bash
cd apps/mobile
npm run start
```

Open in Expo Go (or a dev client) on your phone. The first screen asks for camera access — grant it, then scan the QR shown by the laptop CLI.

If your phone can't reach the laptop via Cloudflare (e.g. on a captive Wi-Fi), tap "Paste link instead" and paste the `agentdeck://pair?...` line from the laptop terminal.

## Architecture

```
agentdeck/
├── apps/
│   ├── cli/                Bun server that bridges WS ↔ agent
│   │   ├── src/index.ts    Entrypoint: tunnel + QR + server
│   │   ├── src/server.ts   Bun.serve with WS auth & command routing
│   │   ├── src/runner.ts   Orchestrates an adapter run, persists messages
│   │   ├── src/store.ts    SQLite (bun:sqlite) — sessions + messages
│   │   ├── src/tunnel.ts   cloudflared wrapper
│   │   └── src/pair.ts     token + QR
│   └── mobile/             Expo Router app
│       ├── app/index.tsx   Sessions list
│       ├── app/pair.tsx    QR scanner
│       ├── app/chat/[id]   Chat detail (stream + input)
│       └── src/store.ts    Zustand WS client + state
└── packages/
    ├── protocol/           Event types shared between CLI and mobile
    └── adapters/           AgentAdapter interface + ClaudeCodeAdapter
```

### Wire protocol

All traffic is JSON over a single WebSocket connection at `/ws`. After connect, the client must send:

```jsonc
{ "type": "auth", "token": "<from QR>", "protocolVersion": 1 }
```

Server responds with `auth.ok` (or `auth.fail`). Subsequent commands include `session.list`, `session.create`, `session.resume`, `prompt`, `session.stop`. Server pushes `agent.message`, `agent.status`, `agent.error` events as they happen. Full schema in [`packages/protocol/src/index.ts`](packages/protocol/src/index.ts).

### Session resume

Each conversation has two IDs:

- **AgentDeck session id** (UUID): the unit of conversation the mobile UI sees. Stable across agents.
- **Native session id** (Claude SDK's `session_id`): tracked per turn so the adapter can pass `resume: <id>` on the next prompt, keeping the conversation context server-side.

When mobile reconnects, it requests `session.resume`; server sends the full message history from SQLite, then live-streams new events. Phone can drop and come back without losing context.

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

- The pairing token is the only auth between phone and laptop. Treat it like a password.
- `--rotate-token` invalidates the existing token. Use it if you suspect leakage.
- The Cloudflare tunnel is publicly reachable; the WS auth handshake is what keeps strangers out.
- Database (`~/.agentdeck/agentdeck.db`) stores conversation history in plaintext. Don't share.

## Roadmap

- [x] Claude Code adapter
- [ ] Codex CLI adapter
- [ ] Push notifications on `agent.done` (Expo Push)
- [ ] Multi-device sync (same session visible on phone + tablet)
- [ ] Built-in BYO-domain support (skip the random `trycloudflare.com` URL)
- [ ] Permission prompts surfaced to mobile (approve/deny tool runs from phone)

## License

MIT. See [LICENSE](LICENSE).
