import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename } from "node:path";
import type { Project } from "@pocket-agents/protocol";
import { PROJECTS_PATH, ensureConfigDir } from "./paths.ts";

/**
 * Tiny JSON file store for saved projects (working directories the user wants
 * to quickly spawn a chat into). We use a flat array instead of a SQLite table
 * because projects are <100 in practice and the file format is easier to
 * inspect/edit by hand.
 *
 * Shape on disk (~/.pocket-agents/projects.json):
 *   [{ name, path, pinned, addedAt }, ...]
 *
 * Order matters: pinned first, then by most-recently-added. The dashboard
 * doesn't re-sort; it renders the array as-is.
 */
export class ProjectStore {
  private cache: Project[] | null = null;

  list(): Project[] {
    if (this.cache) return this.cache;
    ensureConfigDir();
    if (!existsSync(PROJECTS_PATH)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const raw = readFileSync(PROJECTS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      // Defensive: ignore corrupt entries instead of throwing the whole list.
      this.cache = parsed.filter(
        (p): p is Project =>
          p &&
          typeof p.name === "string" &&
          typeof p.path === "string" &&
          typeof p.addedAt === "number",
      );
      return this.cache;
    } catch {
      // Corrupt file — back it up and start fresh so the server keeps booting.
      try {
        writeFileSync(PROJECTS_PATH + ".bak", readFileSync(PROJECTS_PATH));
      } catch {
        /* ignore */
      }
      this.cache = [];
      return this.cache;
    }
  }

  /**
   * Add a project. Validates the path exists + is a directory. Name defaults
   * to the folder basename if omitted. Idempotent on path: if a project with
   * the same path already exists, returns it without duplicating.
   */
  add(opts: { name?: string; path: string; pinned?: boolean }): {
    ok: true;
    project: Project;
  } | { ok: false; error: string } {
    const path = opts.path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
    if (!path) return { ok: false, error: "path is required" };
    if (!existsSync(path)) return { ok: false, error: `path does not exist: ${path}` };
    try {
      if (!statSync(path).isDirectory()) {
        return { ok: false, error: `not a directory: ${path}` };
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const list = this.list();
    const existing = list.find((p) => p.path === path);
    if (existing) {
      // Re-add of an existing path is a no-op except for an optional re-pin.
      if (opts.pinned !== undefined && opts.pinned !== existing.pinned) {
        existing.pinned = opts.pinned;
        this.persist();
      }
      return { ok: true, project: existing };
    }

    const name = (opts.name?.trim() || basename(path) || path).slice(0, 60);
    const project: Project = {
      name,
      path,
      pinned: !!opts.pinned,
      addedAt: Date.now(),
    };
    // Pinned projects float to the top; otherwise newest goes first.
    if (project.pinned) {
      list.unshift(project);
    } else {
      const firstUnpinned = list.findIndex((p) => !p.pinned);
      if (firstUnpinned === -1) list.push(project);
      else list.splice(firstUnpinned, 0, project);
    }
    this.persist();
    return { ok: true, project };
  }

  remove(path: string): boolean {
    const list = this.list();
    const before = list.length;
    this.cache = list.filter((p) => p.path !== path);
    if (this.cache.length === before) return false;
    this.persist();
    return true;
  }

  togglePin(path: string): Project | null {
    const list = this.list();
    const p = list.find((x) => x.path === path);
    if (!p) return null;
    p.pinned = !p.pinned;
    // Re-sort: pinned first.
    this.cache = [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.addedAt - a.addedAt;
    });
    this.persist();
    return p;
  }

  private persist(): void {
    ensureConfigDir();
    writeFileSync(PROJECTS_PATH, JSON.stringify(this.cache ?? [], null, 2), {
      mode: 0o600,
    });
  }
}
