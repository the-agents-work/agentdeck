import { create } from "zustand";
import type {
  AgentDeckCommand,
  AgentDeckEvent,
  AgentMessage,
  PairingPayload,
  SessionStatus,
  SessionSummary,
} from "@agentdeck/protocol";
import { PROTOCOL_VERSION } from "@agentdeck/protocol";
import { clearPairing, loadPairing, savePairing } from "./pair-storage";

type WsState = "idle" | "connecting" | "authing" | "open" | "closed" | "auth_failed";

type ActiveChat = {
  sessionId: string;
  messages: AgentMessage[];
  status: SessionStatus;
};

type Store = {
  // pairing
  pairing: PairingPayload | null;
  pairingLoaded: boolean;

  // ws
  wsState: WsState;
  wsError: string | null;

  // sessions
  sessions: SessionSummary[];
  activeChat: ActiveChat | null;

  // actions
  bootstrap: () => Promise<void>;
  pair: (p: PairingPayload) => Promise<void>;
  unpair: () => Promise<void>;

  send: (cmd: AgentDeckCommand) => void;
  refreshSessions: () => void;
  createSession: () => void;
  openSession: (sessionId: string) => void;
  sendPrompt: (text: string) => void;
  stopSession: () => void;
};

let ws: WebSocket | null = null;

function toWs(httpUrl: string): string {
  if (httpUrl.startsWith("wss://") || httpUrl.startsWith("ws://")) return httpUrl;
  return httpUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
}

export const useStore = create<Store>((set, get) => ({
  pairing: null,
  pairingLoaded: false,
  wsState: "idle",
  wsError: null,
  sessions: [],
  activeChat: null,

  async bootstrap() {
    const p = await loadPairing();
    set({ pairing: p, pairingLoaded: true });
    if (p) connect(p, get, set);
  },

  async pair(p) {
    await savePairing(p);
    set({ pairing: p });
    connect(p, get, set);
  },

  async unpair() {
    try {
      ws?.close();
    } catch {}
    ws = null;
    await clearPairing();
    set({
      pairing: null,
      wsState: "idle",
      sessions: [],
      activeChat: null,
      wsError: null,
    });
  },

  send(cmd) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(cmd));
  },

  refreshSessions() {
    get().send({ type: "session.list" });
  },

  createSession() {
    get().send({ type: "session.create", agent: "claude" });
  },

  openSession(sessionId) {
    set({ activeChat: { sessionId, messages: [], status: "idle" } });
    get().send({ type: "session.resume", sessionId });
  },

  sendPrompt(text) {
    const chat = get().activeChat;
    if (!chat) return;
    get().send({ type: "prompt", sessionId: chat.sessionId, text });
  },

  stopSession() {
    const chat = get().activeChat;
    if (!chat) return;
    get().send({ type: "session.stop", sessionId: chat.sessionId });
  },
}));

function connect(p: PairingPayload, get: () => Store, set: (s: Partial<Store>) => void) {
  try {
    ws?.close();
  } catch {}

  set({ wsState: "connecting", wsError: null });

  const socket = new WebSocket(toWs(p.url));
  ws = socket;

  socket.onopen = () => {
    set({ wsState: "authing" });
    socket.send(
      JSON.stringify({
        type: "auth",
        token: p.token,
        protocolVersion: PROTOCOL_VERSION,
      } satisfies AgentDeckCommand),
    );
  };

  socket.onmessage = (e) => {
    let event: AgentDeckEvent;
    try {
      event = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)) as AgentDeckEvent;
    } catch {
      return;
    }
    handleEvent(event, get, set);
  };

  socket.onerror = () => {
    set({ wsError: "connection error" });
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    set({ wsState: "closed" });
    // Auto-reconnect after a short delay if still paired
    setTimeout(() => {
      const p2 = get().pairing;
      if (p2 && ws === socket) connect(p2, get, set);
    }, 1500);
  };
}

function handleEvent(event: AgentDeckEvent, get: () => Store, set: (s: Partial<Store>) => void) {
  switch (event.type) {
    case "auth.ok":
      set({ wsState: "open", wsError: null });
      get().refreshSessions();
      return;

    case "auth.fail":
      set({ wsState: "auth_failed", wsError: event.reason });
      return;

    case "session.list":
      set({ sessions: event.sessions });
      return;

    case "session.created": {
      set({
        sessions: [event.session, ...get().sessions.filter((s) => s.id !== event.session.id)],
        activeChat: { sessionId: event.session.id, messages: [], status: "idle" },
      });
      return;
    }

    case "session.history": {
      const chat = get().activeChat;
      if (chat && chat.sessionId === event.sessionId) {
        set({
          activeChat: {
            sessionId: event.sessionId,
            messages: event.messages,
            status: event.status,
          },
        });
      }
      return;
    }

    case "session.deleted": {
      set({
        sessions: get().sessions.filter((s) => s.id !== event.sessionId),
        activeChat:
          get().activeChat?.sessionId === event.sessionId ? null : get().activeChat,
      });
      return;
    }

    case "agent.message": {
      const chat = get().activeChat;
      if (chat && chat.sessionId === event.sessionId) {
        set({
          activeChat: { ...chat, messages: [...chat.messages, event.message] },
        });
      }
      // Bump session ordering
      const sessions = get().sessions.map((s) =>
        s.id === event.sessionId
          ? { ...s, lastMessageAt: Date.now(), messageCount: s.messageCount + 1 }
          : s,
      );
      sessions.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      set({ sessions });
      return;
    }

    case "agent.status": {
      const chat = get().activeChat;
      if (chat && chat.sessionId === event.sessionId) {
        set({ activeChat: { ...chat, status: event.status } });
      }
      set({
        sessions: get().sessions.map((s) =>
          s.id === event.sessionId ? { ...s, status: event.status } : s,
        ),
      });
      return;
    }

    case "agent.error":
      set({ wsError: event.error });
      return;

    case "pong":
      return;
  }
}
