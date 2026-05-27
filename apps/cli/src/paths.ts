import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

export const CONFIG_DIR =
  process.env.POCKETAGENTS_HOME || join(homedir(), ".pocket-agents");
export const DB_PATH = join(CONFIG_DIR, "pocket-agents.db");
export const TOKEN_PATH = join(CONFIG_DIR, "token");
export const SERVER_NAME_PATH = join(CONFIG_DIR, "server_name");
export const PROJECTS_PATH = join(CONFIG_DIR, "projects.json");

// Pre-rename users had everything under ~/.agentdeck. On first boot under the
// new brand, move the directory across so they keep their token, chat
// history, etc. without needing to re-pair. Best-effort: if the rename fails
// (cross-device, permission, ...) we fall through and the user starts fresh.
const LEGACY_DIR = join(homedir(), ".agentdeck");
let migratedLegacy = false;

export function ensureConfigDir(): void {
  if (!migratedLegacy) {
    migratedLegacy = true;
    if (
      existsSync(LEGACY_DIR) &&
      !existsSync(CONFIG_DIR) &&
      // Don't auto-migrate if user explicitly pointed POCKETAGENTS_HOME
      // somewhere else — they know what they're doing.
      !process.env.POCKETAGENTS_HOME
    ) {
      try {
        renameSync(LEGACY_DIR, CONFIG_DIR);
        // Also rename the legacy DB file to the new branded name so DB_PATH
        // matches what's on disk. Old file: agentdeck.db; new: pocket-agents.db
        const legacyDb = join(CONFIG_DIR, "agentdeck.db");
        if (existsSync(legacyDb) && !existsSync(DB_PATH)) {
          renameSync(legacyDb, DB_PATH);
          // SQLite WAL/SHM sidecars too — bun:sqlite recreates them but the
          // rename keeps any unflushed pages aligned with the new path.
          for (const ext of ["-wal", "-shm"]) {
            const old = join(CONFIG_DIR, "agentdeck.db" + ext);
            const next = DB_PATH + ext;
            if (existsSync(old) && !existsSync(next)) {
              renameSync(old, next);
            }
          }
        }
        console.log(
          `Migrated ${LEGACY_DIR} → ${CONFIG_DIR} (post-rename to Pocket Agents).`,
        );
      } catch {
        /* fall through — fresh config dir below */
      }
    }
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
}
