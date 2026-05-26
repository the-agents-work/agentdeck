import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AgentMessage } from "@agentdeck/protocol";
import { useStore } from "@/store";
import { theme, spacing } from "@/theme";

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const activeChat = useStore((s) => s.activeChat);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const stopSession = useStore((s) => s.stopSession);
  const openSession = useStore((s) => s.openSession);
  const [input, setInput] = useState("");
  const listRef = useRef<FlatList<AgentMessage>>(null);

  useEffect(() => {
    if (params.id && (!activeChat || activeChat.sessionId !== params.id)) {
      openSession(params.id);
    }
  }, [params.id, activeChat, openSession]);

  useEffect(() => {
    if (activeChat && activeChat.messages.length > 0) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [activeChat?.messages.length]);

  if (!activeChat || activeChat.sessionId !== params.id) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.muted}>Loading session...</Text>
      </SafeAreaView>
    );
  }

  const isRunning = activeChat.status === "running";

  function onSend() {
    const text = input.trim();
    if (!text || isRunning) return;
    sendPrompt(text);
    setInput("");
  }

  return (
    <SafeAreaView style={styles.container} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <FlatList
          ref={listRef}
          data={activeChat.messages}
          keyExtractor={(_, i) => String(i)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <MessageRow msg={item} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.muted}>
                New chat. Send a prompt to wake Claude up.
              </Text>
            </View>
          }
        />

        {isRunning && (
          <View style={styles.statusBar}>
            <Text style={styles.statusText}>Claude is working...</Text>
            <Pressable onPress={stopSession} hitSlop={8}>
              <Text style={styles.stopBtn}>Stop</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={isRunning ? "Wait for current run..." : "Message Claude..."}
            placeholderTextColor={theme.textMuted}
            style={styles.input}
            multiline
            editable={!isRunning}
            onSubmitEditing={onSend}
          />
          <Pressable
            onPress={onSend}
            disabled={isRunning || !input.trim()}
            style={({ pressed }) => [
              styles.sendBtn,
              (isRunning || !input.trim()) && { opacity: 0.4 },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.sendBtnText}>↑</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageRow({ msg }: { msg: AgentMessage }) {
  if (msg.type === "user") {
    return (
      <View style={[styles.bubble, styles.userBubble]}>
        <Text style={styles.userText}>{msg.text ?? ""}</Text>
      </View>
    );
  }

  if (msg.type === "assistant") {
    if (msg.tool) {
      return (
        <View style={styles.toolCard}>
          <Text style={styles.toolLabel}>Tool · {msg.tool.name}</Text>
          {msg.tool.input != null && (
            <Text style={styles.toolBody} numberOfLines={6}>
              {prettyJson(msg.tool.input)}
            </Text>
          )}
        </View>
      );
    }
    return (
      <View style={[styles.bubble, styles.assistantBubble]}>
        <Text style={styles.assistantText}>{msg.text ?? ""}</Text>
      </View>
    );
  }

  if (msg.type === "tool_result" || msg.toolResult) {
    return (
      <View style={[styles.toolCard, msg.toolResult?.isError && styles.toolCardError]}>
        <Text style={styles.toolLabel}>
          Tool result {msg.toolResult?.isError ? "(error)" : ""}
        </Text>
        <Text style={styles.toolBody} numberOfLines={6}>
          {typeof msg.toolResult?.output === "string"
            ? msg.toolResult.output
            : prettyJson(msg.toolResult?.output)}
        </Text>
      </View>
    );
  }

  if (msg.type === "result") {
    return (
      <View style={styles.system}>
        <Text style={styles.systemText}>{msg.text ?? "done"}</Text>
      </View>
    );
  }

  if (msg.type === "system") {
    return (
      <View style={styles.system}>
        <Text style={styles.systemText}>{msg.text ?? "session ready"}</Text>
      </View>
    );
  }

  if (msg.type === "error") {
    return (
      <View style={[styles.system, { borderColor: theme.error }]}>
        <Text style={[styles.systemText, { color: theme.error }]}>
          {msg.text ?? "error"}
        </Text>
      </View>
    );
  }

  return null;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  list: { padding: spacing(3), gap: spacing(2) },
  empty: { padding: spacing(8), alignItems: "center" },
  muted: { color: theme.textMuted },
  bubble: {
    padding: spacing(3),
    borderRadius: 12,
    maxWidth: "92%",
  },
  userBubble: {
    backgroundColor: theme.accentMuted,
    alignSelf: "flex-end",
  },
  userText: { color: theme.text, fontSize: 15 },
  assistantBubble: {
    backgroundColor: theme.surface,
    alignSelf: "flex-start",
  },
  assistantText: { color: theme.text, fontSize: 15, lineHeight: 22 },
  toolCard: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    padding: spacing(2),
    borderLeftWidth: 3,
    borderLeftColor: theme.accent,
  },
  toolCardError: { borderLeftColor: theme.error },
  toolLabel: { color: theme.textMuted, fontSize: 11, fontWeight: "700", marginBottom: 4 },
  toolBody: { color: theme.text, fontSize: 12, fontFamily: "Menlo" },
  system: {
    padding: spacing(2),
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignSelf: "center",
  },
  systemText: { color: theme.textMuted, fontSize: 12 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(2),
    backgroundColor: theme.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  statusText: { color: theme.warning, fontSize: 12 },
  stopBtn: { color: theme.error, fontWeight: "700", fontSize: 12 },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: spacing(2),
    gap: spacing(2),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    backgroundColor: theme.surface,
    borderRadius: 18,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    color: theme.text,
    fontSize: 15,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnText: { color: "#0a0a0b", fontSize: 20, fontWeight: "700" },
});
