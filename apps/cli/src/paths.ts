import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const CONFIG_DIR = process.env.AGENTDECK_HOME || join(homedir(), ".agentdeck");
export const DB_PATH = join(CONFIG_DIR, "agentdeck.db");
export const TOKEN_PATH = join(CONFIG_DIR, "token");
export const SERVER_NAME_PATH = join(CONFIG_DIR, "server_name");
export const PIN_PATH = join(CONFIG_DIR, "pin");

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}
