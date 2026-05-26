import type { AgentMessage, SessionStatus } from "@pocket-agents/protocol";
import { adapters } from "@pocket-agents/adapters";
import { SessionStore } from "./store.ts";

type Subscriber = (event:
  | { type: "message"; sessionId: string; message: AgentMessage }
  | { type: "status"; sessionId: string; status: SessionStatus; durationMs?: number }
  | { type: "error"; sessionId: string; error: string }) => void;

/**
 * Orchestrates an agent run for a session: pulls from adapter, persists
 * each message, fans out to subscribers (WebSocket connections).
 * Also tracks active runs so we can stop them on user request.
 */
export class Runner {
  private readonly subs = new Set<Subscriber>();
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly store: SessionStore) {}

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(event: Parameters<Subscriber>[0]) {
    for (const sub of this.subs) sub(event);
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  stop(sessionId: string): boolean {
    const ctrl = this.active.get(sessionId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /** Fire-and-forget. Use subscribe() to receive streamed events. */
  async run(sessionId: string, prompt: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      this.emit({ type: "error", sessionId, error: `Unknown session ${sessionId}` });
      return;
    }
    if (this.active.has(sessionId)) {
      this.emit({ type: "error", sessionId, error: "Session already running" });
      return;
    }

    const adapter = adapters[session.agent];
    if (!adapter) {
      this.emit({ type: "error", sessionId, error: `No adapter for ${session.agent}` });
      return;
    }

    // Persist + emit the user's own prompt so all clients see it
    const userMsg: AgentMessage = {
      type: "user",
      raw: { role: "user", content: prompt },
      text: prompt,
    };
    this.store.appendMessage(sessionId, userMsg);
    this.emit({ type: "message", sessionId, message: userMsg });

    const ctrl = new AbortController();
    this.active.set(sessionId, ctrl);
    this.store.setStatus(sessionId, "running");
    this.emit({ type: "status", sessionId, status: "running" });

    const gen = adapter.run({
      prompt,
      resumeFromNativeId: session.nativeSessionId,
      cwd: session.cwd ?? undefined,
      signal: ctrl.signal,
    });

    let result: { nativeSessionId: string | null; durationMs: number; ok: boolean } | null = null;
    try {
      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value;
          break;
        }
        const msg = next.value;
        // Skip echoing the user prompt back — adapters re-emit it.
        if (msg.type === "user") continue;
        this.store.appendMessage(sessionId, msg);
        this.emit({ type: "message", sessionId, message: msg });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", sessionId, error });
      this.store.setStatus(sessionId, "error");
    } finally {
      this.active.delete(sessionId);
    }

    if (result) {
      this.store.setNativeSessionId(sessionId, result.nativeSessionId);
      const status: SessionStatus = result.ok ? "done" : "error";
      this.store.setStatus(sessionId, status);
      this.emit({ type: "status", sessionId, status, durationMs: result.durationMs });
    }
  }
}
