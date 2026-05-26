import { useEffect } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Redirect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "@/store";
import { theme, spacing } from "@/theme";

export default function SessionsScreen() {
  const router = useRouter();
  const pairing = useStore((s) => s.pairing);
  const pairingLoaded = useStore((s) => s.pairingLoaded);
  const wsState = useStore((s) => s.wsState);
  const wsError = useStore((s) => s.wsError);
  const sessions = useStore((s) => s.sessions);
  const refresh = useStore((s) => s.refreshSessions);
  const createSession = useStore((s) => s.createSession);
  const openSession = useStore((s) => s.openSession);
  const unpair = useStore((s) => s.unpair);

  useEffect(() => {
    if (wsState === "open") refresh();
  }, [wsState, refresh]);

  if (!pairingLoaded) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color={theme.accent} />
      </SafeAreaView>
    );
  }

  if (!pairing) {
    return <Redirect href="/pair" />;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>AgentDeck</Text>
          <Text style={styles.subtitle}>
            {pairing.name ?? pairing.url}  ·  {labelFor(wsState)}
            {wsError ? `  ·  ${wsError}` : ""}
          </Text>
        </View>
        <Pressable onPress={unpair} hitSlop={8}>
          <Text style={styles.muted}>Unpair</Text>
        </Pressable>
      </View>

      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingBottom: spacing(20) }}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              openSession(item.id);
              router.push(`/chat/${item.id}`);
            }}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {item.agent} · {item.messageCount} msgs · {timeAgo(item.lastMessageAt)}
              </Text>
            </View>
            <StatusDot status={item.status} />
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.muted}>
              {wsState === "open"
                ? "No chats yet — tap + to start one."
                : `Waiting for connection (${labelFor(wsState)})...`}
            </Text>
          </View>
        }
      />

      <Pressable
        onPress={() => {
          createSession();
          // Optimistic nav happens after server sends session.created via store.
        }}
        style={({ pressed }) => [styles.fab, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.fabText}>+ New chat</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running" ? theme.warning :
    status === "error" ? theme.error :
    status === "done" ? theme.success : theme.textMuted;
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

function labelFor(s: string) {
  switch (s) {
    case "open": return "connected";
    case "connecting": return "connecting...";
    case "authing": return "authenticating...";
    case "closed": return "reconnecting...";
    case "auth_failed": return "auth failed";
    default: return s;
  }
}

function timeAgo(ts: number) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing(4),
    paddingTop: spacing(2),
  },
  title: { color: theme.text, fontSize: 24, fontWeight: "700" },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(3),
    backgroundColor: theme.bg,
  },
  rowPressed: { backgroundColor: theme.surface },
  rowTitle: { color: theme.text, fontSize: 16, fontWeight: "500" },
  rowSub: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginLeft: spacing(4) },
  empty: { padding: spacing(8), alignItems: "center" },
  muted: { color: theme.textMuted, fontSize: 14 },
  fab: {
    position: "absolute",
    right: spacing(5),
    bottom: spacing(8),
    backgroundColor: theme.accent,
    paddingHorizontal: spacing(5),
    paddingVertical: spacing(3),
    borderRadius: 999,
  },
  fabText: { color: "#0a0a0b", fontWeight: "700", fontSize: 14 },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: spacing(2) },
});
