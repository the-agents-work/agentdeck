import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PairingPayload } from "@agentdeck/protocol";

const KEY = "agentdeck:pair:v1";

export async function loadPairing(): Promise<PairingPayload | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PairingPayload;
  } catch {
    return null;
  }
}

export async function savePairing(p: PairingPayload): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(p));
}

export async function clearPairing(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

/** Accepts either a raw QR-encoded JSON string OR an `agentdeck://pair?...` deep link. */
export function parsePairingPayload(input: string): PairingPayload | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("agentdeck://pair")) {
    try {
      const u = new URL(trimmed);
      const url = u.searchParams.get("url");
      const token = u.searchParams.get("token");
      const v = Number(u.searchParams.get("v") ?? "1");
      const name = u.searchParams.get("name") ?? undefined;
      if (!url || !token) return null;
      return { v, url, token, name };
    } catch {
      return null;
    }
  }

  // Otherwise, expect JSON payload
  try {
    const p = JSON.parse(trimmed) as PairingPayload;
    if (!p?.url || !p?.token) return null;
    return p;
  } catch {
    return null;
  }
}
