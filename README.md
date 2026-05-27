# Pocket Agents

> Pocket-sized remote control for coding agents. One command on your
> laptop, open a link on any device, drive Claude Code or Codex from
> the phone in your pocket.

```
┌──────────┐       Cloudflare       ┌──────────┐       AgentAdapter      ┌──────────────────┐
│  Phone   │ ─────── tunnel ──────▶ │  Laptop  │ ──────────────────────▶ │  Claude Code     │
│ (Browser)│         (WSS)          │  (Bun)   │                         │  Codex CLI       │
└──────────┘                        └──────────┘                         └──────────────────┘
        open URL once       persists sessions in            spawns adapter subprocesses
                            ~/.pocket-agents/*.db           with native session resume
```

## What you actually get

- A **dashboard URL + QR code** printed in your terminal on every launch.
- A **dark, mobile-first chat UI** that runs in any browser — no app to install.
- **Sessions persist** to SQLite on your laptop. Close the tab, lock the
  phone, come back hours later — the conversation is still there.
- **Multi-device sync** — rename or delete a chat from your laptop and the
  phone tab updates in real time.
- **Paste screenshots** into the composer; Claude Vision reads them inline.
- **Live elapsed timer** while an agent is running, "last run 4m 12s" chip
  when it finishes. Glance at the header instead of polling.

## Why

- **Long agent runs feel terrible chained to a terminal.** Fire off a
  prompt, lock your phone, come back when the work's done.
- **No app to install.** Same URL works on phone, tablet, another laptop.
- **No Cloudflare account, no API key.** Anonymous quick tunnels work
  out of the box. The agent uses whatever `claude login` / `codex login`
  you already have.

## Status

`v0.1.x` — Claude Code adapter, Codex CLI adapter, web dashboard, built-in
Cloudflare tunnel, image input, multi-device sync. Single-user / personal
laptop posture — not hardened for shared deployment.

## Install (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/the-agents-work/pocket-agents/main/install.sh | bash
```

The installer:

1. Installs **Bun** if it's missing (the project uses `bun:sqlite`).
2. On Debian/Ubuntu: installs `unzip` if missing (Bun installer needs it).
3. Clones the repo to `~/.local/share/pocket-agents`.
4. Builds the CLI bundle.
5. Drops a `pocket-agents` wrapper into `~/.local/bin`.

Then add `~/.local/bin` to `$PATH` (the installer reminds you how) and
start with:

```bash
pocket-agents
```

Re-running the installer pulls the latest `main`, rebuilds, and updates
the wrapper. It's idempotent.

### Prerequisites

- `bash`, `curl`, `git` — preinstalled on macOS (Xcode Command Line
  Tools) and every Linux distro.
- macOS or Linux. Windows: use WSL.

Anything else (Bun, unzip, cloudflared) is auto-installed.

## First run

```
$ pocket-agents
Pocket Agents v0.1.0
Server name: laptop-1a2b
Config dir:  ~/.pocket-agents
PIN gate:    off (use --gen-pin or --set-pin to enable)

Port 3737 is already in use. Picking a free port instead — set POCKETAGENTS_PORT to a specific value if you want a stable one.
Listening on http://localhost:63488
Tunnel: https://example-quick-tunnel.trycloudflare.com

──────────────── Open this URL on any device ────────────────

  https://example-quick-tunnel.trycloudflare.com/?t=<token>

  (Scan QR below from your phone to open in mobile browser)

  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  █ ▄▄▄▄▄ █ ████  ▄█ █ ▄▄▄▄▄ █
  ... (qrcode-terminal output)
─────────────────────────────────────────────────────────────
```

Open the URL on your phone (paste or scan). The page strips the token
from the URL and stores it in `localStorage`, so subsequent visits stay
paired without leaving the token in your browser history.

That's the whole pairing flow. No native app, no Cloudflare signup, no
API keys.

## Day-to-day use

**Pick a workspace.** First time you tap *New Claude chat* (or *New
Codex chat*), the picker lets you choose a folder for the agent to
work in. `~` (Home) is at the top; `~/Documents/GitHub`, `~/Projects`,
and a few other usual suspects are auto-discovered. Pinned folders
float to the top on subsequent runs.

**Send a prompt.** Type, hit ↑. The header shows `working · 0m 02s`
ticking up while the agent runs. When it finishes you get a `last run
2m 14s` chip and the ERROR badge if it bailed.

**Paste a screenshot.** `Cmd+Ctrl+Shift+4` on macOS to grab a region
to clipboard, then `Cmd+V` into the composer. Up to 5 images per turn,
5 MB each. Claude Vision reads them natively — no OCR pass needed.

**Rename or delete a chat.** Hover (desktop) or tap (mobile) any
sidebar row → the ✎ and 🗑 icons appear on the right.

**Close the tab, come back later.** The agent keeps running on the
laptop. SQLite at `~/.pocket-agents/pocket-agents.db` is the source
of truth; opening the dashboard again replays the full transcript and
streams whatever new events arrive.

## PIN gate (recommended)

The pairing token alone keeps strangers out, but it's just a URL — if
it ends up in a screenshot, screen-share, or chat log, you want a
second factor:

```bash
pocket-agents --gen-pin           # random 6-digit code, printed once
# or
pocket-agents --set-pin 408215    # pick your own
```

Restart `pocket-agents`. The dashboard now prompts for the PIN after
pairing. Five wrong attempts drops the socket. Clear with
`--clear-pin`.

The PIN is printed on every boot so you can see it in your terminal
scrollback — that's a deliberate convenience for personal-laptop use.
If you ever screen-share that terminal, run `--clear-pin` first.

## Slash commands

Interactive slash commands (`/help`, `/clear`, `/init`, `/goal`,
`/loop`, `/security-review`, `/agents`, …) are **TUI-only features of
the `claude` CLI**. They aren't available through the Agent SDK that
Pocket Agents uses. Asking the model `/goal foo` over the SDK gets you
a literal `"/goal isn't available in this environment."` reply.

Pocket Agents detects slash-prefixed input and shows a small hint
instead of round-tripping to the model. If you want the equivalent of
`/goal`, type the request as plain English ("keep working until X
happens, don't stop early") and Claude follows.

Hooks you configured in `~/.claude/settings.json` still fire as
normal. Pocket Agents surfaces a small `⚡ hook · done` chip when a
hook completes (SessionStart-class hooks are filtered out as noise).

## How auth works

No API key configuration in Pocket Agents itself. The wrapped
`@anthropic-ai/claude-agent-sdk` inherits credentials in this order:

1. `ANTHROPIC_API_KEY` env var (pay-per-use API)
2. `~/.claude/credentials.json` from `claude login` (Pro/Max subscription)

Most devs already have step 2, so Pocket Agents just works on your
existing subscription.

## CLI flags

| Flag                  | Effect                                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| `--no-tunnel`         | LAN-only mode. URL uses your laptop's LAN IP. Phone must be on the same Wi-Fi. |
| `--rotate-token`      | Generate a fresh pairing token. All previously paired devices lose access.     |
| `--gen-pin`           | Generate a random 6-digit PIN, save it, print it once.                         |
| `--set-pin <4-10>`    | Save a PIN you choose.                                                         |
| `--clear-pin`         | Remove the saved PIN (PIN gate off).                                           |
| `--help`              | Show help.                                                                     |

Env vars:

| Variable                       | Default               | Purpose                                              |
| ------------------------------ | --------------------- | ---------------------------------------------------- |
| `POCKETAGENTS_PORT`            | `3737`                | Server port. Falls back to a random one if busy.     |
| `POCKETAGENTS_HOME`            | `~/.pocket-agents`    | Config + SQLite db directory.                        |
| `POCKETAGENTS_NO_TUNNEL`       | unset                 | Skip cloudflared, same effect as `--no-tunnel`.      |
| `POCKETAGENTS_PIN`             | unset                 | PIN value, overrides the `pin` file.                 |
| `POCKETAGENTS_DEFAULT_CWD`     | `$HOME`               | Working dir for sessions without an explicit one.    |
| `POCKETAGENTS_SCAN_ROOTS`      | (curated list)        | Override folder-discovery roots in the picker.       |
| `POCKETAGENTS_CODEX_BIN`       | `codex`               | Codex CLI binary name on $PATH.                      |
| `POCKETAGENTS_CODEX_APPROVAL`  | `never`               | Codex `--approval` flag.                             |
| `POCKETAGENTS_CODEX_SANDBOX`   | `danger-full-access`  | Codex `--sandbox` flag. Set tighter if you prefer.   |
| `POCKETAGENTS_CODEX_MODEL`     | unset                 | Codex `--model` override. Unset = local config.      |

## Architecture

```
pocket-agents/
├── apps/
│   └── cli/                       Bun server: WS + agent runner + static dashboard
│       ├── src/index.ts           Entrypoint: tunnel + URL printout + QR
│       ├── src/server.ts          Bun.serve — /dashboard + /ws + /health
│       ├── src/runner.ts          Orchestrates an adapter run, persists messages
│       ├── src/store.ts           SQLite (bun:sqlite) — sessions + messages
│       ├── src/tunnel.ts          cloudflared wrapper (quick tunnel)
│       ├── src/projects.ts        Saved-folder picker store
│       ├── src/fsscan.ts          Folder auto-discovery
│       ├── src/pair.ts            Token rotation + server naming
│       └── static/dashboard.html  Single-file Preact SPA (no build step)
├── packages/
│   ├── protocol/                  Event types shared by server + dashboard
│   └── adapters/                  AgentAdapter interface + Claude/Codex impls
└── install.sh                     One-shot installer
```

### Wire protocol

All traffic is JSON over a single WebSocket connection at `/ws`. After
connect, the client sends:

```jsonc
{ "type": "auth", "token": "<from URL>", "protocolVersion": 1 }
```

Server responds with `auth.ok` (and `pinRequired: true` if you set a
PIN). The full command + event schema lives in
[`packages/protocol/src/index.ts`](packages/protocol/src/index.ts).

### Session resume

Two ids per conversation:

- **Pocket Agents session id** (UUID) — what the dashboard sees, stable
  across agents.
- **Native session id** (Claude SDK `session_id` or Codex thread id) —
  persisted per turn so the adapter can resume on the next prompt.

When the browser reconnects, it sends `session.resume`; the server
ships the full message history from SQLite, then live-streams new
events.

### Ghost-run cleanup on boot

If the laptop crashes mid-run (Ctrl+C, reboot, OOM), the affected
sessions would otherwise stay `status: 'running'` in SQLite forever —
the dashboard would happily render a phantom WORKING timer that never
advances. The store flips any such orphan to `status: 'error'` at
startup so the UI always reflects reality.

### Port fallback

`POCKETAGENTS_PORT` (default `3737`) is tried first. If it's busy
(EADDRINUSE), the server retries on port 0, letting the OS pick a
free one, and prints the chosen port. The tunnel URL adjusts
automatically. We don't try to kill the process holding the port —
that's almost always something the user wants to keep running.

## Codex CLI support

Pocket Agents runs Codex through `codex exec --json` and resumes each
chat with `codex exec resume`. Defaults:

- `POCKETAGENTS_CODEX_BIN=codex`
- `POCKETAGENTS_CODEX_APPROVAL=never`
- `POCKETAGENTS_CODEX_SANDBOX=danger-full-access`
- `POCKETAGENTS_CODEX_MODEL` unset → Codex uses your local config

Tighten the sandbox to `workspace-write` or `read-only` if you want a
more cautious remote-control posture. Image attachments are
Claude-only for now — Codex sessions silently ignore them and the
composer toasts a warning if you try.

## Adding a new adapter (Aider, …)

Implement [`AgentAdapter`](packages/adapters/src/types.ts):

```ts
import type {
  AgentAdapter,
  AdapterRunOptions,
  AdapterRunResult,
} from "./types";

export class AiderAdapter implements AgentAdapter {
  readonly name = "aider" as const;

  async *run(
    opts: AdapterRunOptions,
  ): AsyncGenerator<AgentMessage, AdapterRunResult> {
    // Spawn a subprocess or use an SDK; stream events; yield AgentMessage.
    // Track the native session id so callers can resume next turn.
  }
}
```

Register it in `packages/adapters/src/index.ts`.

## Security posture

This is a **single-user, personal-laptop** tool. The pairing token plus
optional PIN keeps drive-bys out, not a determined attacker on the same
network.

- The dashboard URL contains the pairing token as `?t=...` once. After
  the first visit the token lives in `localStorage` and is stripped
  from the URL.
- `--rotate-token` invalidates the existing token. Use it if a link
  leaked.
- Cloudflare quick tunnels are publicly reachable. WS auth (token +
  PIN) is what keeps strangers out. Treat the dashboard URL like a
  password.
- The PIN is printed on every boot for personal-laptop convenience.
  Skip with `--clear-pin` before screen-sharing the terminal.
- `~/.pocket-agents/pocket-agents.db` stores conversation history in
  plaintext. Don't share it.
- `bypassPermissions` is the default permission posture for the Claude
  adapter, matching `claude --dangerously-skip-permissions`. Set
  `POCKETAGENTS_PERMISSION_MODE=default` (or `acceptEdits`, etc.) to
  re-enable interactive prompts — note the dashboard can't surface
  them, so prompts will hang the run.

## From source (development)

```bash
git clone https://github.com/the-agents-work/pocket-agents
cd pocket-agents
bun install
bun apps/cli/src/index.ts
```

## Roadmap

- [x] Claude Code adapter
- [x] Codex CLI adapter
- [x] Web dashboard
- [x] Cloudflare quick tunnel built-in
- [x] Image input (paste / attach) for Claude
- [x] Session rename + delete from the sidebar
- [x] Auto-title sessions from the first prompt
- [ ] Single-binary distribution via GitHub Releases (no Bun preinstall)
- [ ] npm publish (currently blocked on a 2FA chore — install.sh works today)
- [ ] PWA install + push notifications on `agent.done`
- [ ] Tool permission prompts surfaced to the dashboard (approve/deny per call)
- [ ] BYO custom domain (named Cloudflare tunnel, not a random `trycloudflare.com` URL)
- [ ] More adapters (Aider, Goose, …)

## License

MIT. See [LICENSE](LICENSE).
