import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "@/store";
import { parsePairingPayload } from "@/pair-storage";
import { theme, spacing } from "@/theme";

export default function PairScreen() {
  const router = useRouter();
  const pair = useStore((s) => s.pair);
  const [permission, requestPermission] = useCameraPermissions();
  const [showManual, setShowManual] = useState(false);
  const [manualText, setManualText] = useState("");
  const [scanning, setScanning] = useState(true);

  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, [permission, requestPermission]);

  async function handlePayload(raw: string) {
    setScanning(false);
    const parsed = parsePairingPayload(raw);
    if (!parsed) {
      Alert.alert(
        "Invalid pairing code",
        "Make sure you scanned the QR shown by `agentdeck` on your laptop.",
        [{ text: "Try again", onPress: () => setScanning(true) }],
      );
      return;
    }
    await pair(parsed);
    router.replace("/");
  }

  return (
    <SafeAreaView style={styles.container} edges={["bottom"]}>
      {!showManual ? (
        <View style={styles.cameraWrap}>
          {permission?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={scanning ? ({ data }) => handlePayload(data) : undefined}
            />
          ) : (
            <View style={styles.permWrap}>
              <Text style={styles.text}>
                Camera permission is required to scan the pairing QR.
              </Text>
              <Pressable style={styles.btn} onPress={requestPermission}>
                <Text style={styles.btnText}>Grant permission</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.overlay}>
            <View style={styles.reticle} />
            <Text style={styles.help}>
              Run `agentdeck` on your laptop, then point camera at the QR code.
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.manualWrap}>
          <Text style={styles.label}>Paste pairing link or JSON</Text>
          <TextInput
            value={manualText}
            onChangeText={setManualText}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="agentdeck://pair?url=... or {&quot;v&quot;:1,&quot;url&quot;:...}"
            placeholderTextColor={theme.textMuted}
            style={styles.input}
          />
          <Pressable
            style={styles.btn}
            onPress={() => handlePayload(manualText)}
          >
            <Text style={styles.btnText}>Pair</Text>
          </Pressable>
        </View>
      )}

      <Pressable
        onPress={() => setShowManual((v) => !v)}
        style={styles.toggle}
      >
        <Text style={styles.muted}>
          {showManual ? "Scan QR instead" : "Paste link instead"}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  cameraWrap: { flex: 1, position: "relative", backgroundColor: "#000" },
  overlay: {
    ...(StyleSheet.absoluteFill as object),
    alignItems: "center",
    justifyContent: "center",
  },
  reticle: {
    width: 240,
    height: 240,
    borderColor: theme.accent,
    borderWidth: 3,
    borderRadius: 16,
    backgroundColor: "transparent",
  },
  help: {
    color: theme.text,
    marginTop: spacing(4),
    paddingHorizontal: spacing(8),
    textAlign: "center",
    fontSize: 13,
  },
  permWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing(6) },
  text: { color: theme.text, textAlign: "center", marginBottom: spacing(4) },
  manualWrap: { flex: 1, padding: spacing(4), gap: spacing(3) },
  label: { color: theme.textMuted, fontSize: 13 },
  input: {
    minHeight: 120,
    backgroundColor: theme.surface,
    color: theme.text,
    padding: spacing(3),
    borderRadius: 8,
    fontFamily: "Menlo",
    fontSize: 12,
  },
  btn: {
    backgroundColor: theme.accent,
    paddingVertical: spacing(3),
    borderRadius: 8,
    alignItems: "center",
  },
  btnText: { color: "#0a0a0b", fontWeight: "700" },
  toggle: { padding: spacing(4), alignItems: "center" },
  muted: { color: theme.textMuted },
});
