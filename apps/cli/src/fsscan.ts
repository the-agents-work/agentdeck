import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Folder discovery — scans well-known parent directories for git repos and
 * common workspaces so the dashboard picker can show "DISCOVERED" suggestions
 * instead of forcing the user to type a path on their phone.
 *
 * Strategy:
 *   1. Look at a fixed set of candidate parents (~, ~/Documents, etc).
 *   2. For each that exists, list its immediate children that are
 *      directories.
 *   3. Mark children that contain `.git` as git repos (more interesting).
 *   4. Sort by mtime descending — recently-touched first.
 *   5. Cap the result at MAX_RESULTS so a giant ~/Documents/GitHub with 100
 *      repos doesn't blow up the picker.
 *
 * We intentionally DO NOT recurse. One level deep keeps the scan fast
 * (<50ms on a normal machine) and matches user mental model:
 *   "a workspace lives directly under ~/Documents/GitHub/<name>"
 *
 * Custom scan roots can be added via env POCKETAGENTS_SCAN_ROOTS=path1:path2.
 */

export type DiscoveredFolder = {
  /** Absolute path. */
  path: string;
  /** Folder basename. */
  name: string;
  /** Parent dir for grouping, e.g. "~/Documents/GitHub". */
  parent: string;
  /** True if the folder contains a .git/ directory. */
  isGitRepo: boolean;
  /** ms epoch of last modification (used for recency sort). */
  mtimeMs: number;
};

const HOME = homedir();
const DEFAULT_ROOTS = [
  HOME, // children like ~/Code, ~/dev
  join(HOME, "Documents"),
  join(HOME, "Documents", "GitHub"),
  join(HOME, "Projects"),
  join(HOME, "Code"),
  join(HOME, "Developer"),
  join(HOME, "Desktop"),
  join(HOME, "dev"),
  join(HOME, "src"),
  join(HOME, "work"),
  join(HOME, "workspace"),
];

const MAX_RESULTS = 30;

/** Folders to never surface (vendored, system, IDE caches). */
const SKIP_NAMES = new Set([
  "node_modules",
  ".cache",
  ".cargo",
  ".rustup",
  ".npm",
  ".yarn",
  ".bun",
  ".nvm",
  ".m2",
  ".gradle",
  "Library",
  "Applications",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Trash",
]);

export function scanFolders(): DiscoveredFolder[] {
  const roots = (process.env.POCKETAGENTS_SCAN_ROOTS ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  const allRoots = roots.length ? roots : DEFAULT_ROOTS;

  const seen = new Set<string>();
  const out: DiscoveredFolder[] = [];

  for (const root of allRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue; // skip dotfolders at root level
      if (SKIP_NAMES.has(name)) continue;
      const fullPath = join(root, name);
      if (seen.has(fullPath)) continue;
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      seen.add(fullPath);
      const isGitRepo = existsSync(join(fullPath, ".git"));
      out.push({
        path: fullPath,
        name,
        parent: shortenHome(root),
        isGitRepo,
        mtimeMs: st.mtimeMs,
      });
    }
  }

  // Git repos first, then recent mtime within each tier.
  out.sort((a, b) => {
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });

  return out.slice(0, MAX_RESULTS);
}

function shortenHome(p: string): string {
  if (p === HOME) return "~";
  if (p.startsWith(HOME + "/")) return "~" + p.slice(HOME.length);
  return p;
}
