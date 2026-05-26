export const theme = {
  bg: "#0a0a0b",
  surface: "#141416",
  surfaceAlt: "#1c1c20",
  border: "#27272a",
  text: "#fafafa",
  textMuted: "#71717a",
  accent: "#a78bfa",
  accentMuted: "#4c1d95",
  success: "#22c55e",
  error: "#ef4444",
  warning: "#f59e0b",
} as const;

export const spacing = (n: number) => n * 4;
