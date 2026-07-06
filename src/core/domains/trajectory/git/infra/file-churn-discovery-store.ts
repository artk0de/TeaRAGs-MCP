/**
 * Persistent tier of the file-churn discovery cache — the numstat-preserving
 * sibling of GitCommitDiscoveryStore.
 *
 * Layout: `<baseDir>/<sha256(repoRoot).hex.slice(0,16)>/<head>.json` — keyed
 * by repoRoot hash (git history is a repo property shared across every
 * collection indexing that repo). Stale-HEAD files are dropped on save, which
 * IS the size cap for the directory (one snapshot per repo).
 *
 * The baseDir subdir (`file-churn-discovery`) is DISTINCT from the chunk
 * matrix's `git-discovery`, so the two snapshots never collide — critical
 * because each store's `save` deletes every OTHER `*.json` in its repoDir.
 *
 * Everything is best-effort: corrupt / mismatched / oversized payloads degrade
 * silently to null so the discovery rebuilds from git. Sync node:fs APIs by
 * precedent (commit-discovery-store.ts, infra/registry/registry-file.ts).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommitFileNumstat } from "../../../../adapters/vcs/types.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { FileChurnDiscoveryPersistence, PersistedFileChurnDiscovery } from "./file-churn-discovery.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Cheap structural validation of one file-churn entry. */
function isValidEntry(value: unknown): value is CommitFileNumstat {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { commit?: unknown; files?: unknown };
  if (!Array.isArray(entry.files)) return false;
  for (const file of entry.files) {
    if (typeof file !== "object" || file === null) return false;
    const f = file as Record<string, unknown>;
    if (typeof f.path !== "string" || typeof f.added !== "number" || typeof f.deleted !== "number") return false;
  }
  if (typeof entry.commit !== "object" || entry.commit === null) return false;
  const commit = entry.commit as Record<string, unknown>;
  return (
    typeof commit.sha === "string" &&
    typeof commit.author === "string" &&
    typeof commit.authorEmail === "string" &&
    typeof commit.body === "string" &&
    typeof commit.timestamp === "number" &&
    isStringArray(commit.parents)
  );
}

export class FileChurnDiscoveryStore implements FileChurnDiscoveryPersistence {
  private readonly baseDir: string;

  constructor(
    baseDir?: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    // Existing repo convention for app data (adapters/qdrant/embedded/download.ts).
    this.baseDir =
      baseDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "file-churn-discovery");
  }

  load(repoRoot: string, head: string): PersistedFileChurnDiscovery | null {
    return this.read(join(this.repoDir(repoRoot), `${head}.json`), repoRoot, head);
  }

  loadLatest(repoRoot: string): PersistedFileChurnDiscovery | null {
    try {
      const dir = this.repoDir(repoRoot);
      let newest: string | undefined;
      let newestMtime = -Infinity;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const mtime = statSync(join(dir, file)).mtimeMs;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          newest = file;
        }
      }
      if (!newest) return null;
      // Same validation as `load` except the head is whatever the file says.
      return this.read(join(dir, newest), repoRoot);
    } catch (error) {
      this.debugLog("loadLatest", error);
      return null;
    }
  }

  save(repoRoot: string, head: string, sinceIso: string, entries: CommitFileNumstat[]): void {
    try {
      const payload: PersistedFileChurnDiscovery = { version: 1, repoRoot, head, sinceIso, entries };
      const data = JSON.stringify(payload);
      // Oversized window → skip persistence; the run keeps its in-memory copy.
      if (Buffer.byteLength(data) > this.maxBytes) return;

      const dir = this.repoDir(repoRoot);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${head}.json`);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, target); // atomic replace

      // Stale-HEAD cleanup — every OTHER *.json is a superseded snapshot.
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".json") && file !== `${head}.json`) {
          unlinkSync(join(dir, file));
        }
      }
    } catch (error) {
      // Best-effort persistence: a failed save only costs the next run a log.
      this.debugLog("save", error);
    }
  }

  private repoDir(repoRoot: string): string {
    return join(this.baseDir, createHash("sha256").update(repoRoot).digest("hex").slice(0, 16));
  }

  private read(filePath: string, repoRoot: string, head?: string): PersistedFileChurnDiscovery | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      return this.validate(parsed, repoRoot, head);
    } catch (error) {
      this.debugLog("load", error);
      return null;
    }
  }

  /**
   * ANY validation failure → null (silent rebuild semantics). The repoRoot
   * equality check guards against sha256-prefix collisions between repos.
   */
  private validate(parsed: unknown, repoRoot: string, head?: string): PersistedFileChurnDiscovery | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as Record<string, unknown>;
    if (snapshot.version !== 1) return null;
    if (snapshot.repoRoot !== repoRoot) return null;
    if (typeof snapshot.head !== "string" || (head !== undefined && snapshot.head !== head)) return null;
    if (typeof snapshot.sinceIso !== "string") return null;
    if (!Array.isArray(snapshot.entries) || !snapshot.entries.every(isValidEntry)) return null;
    return snapshot as unknown as PersistedFileChurnDiscovery;
  }

  private debugLog(op: string, error: unknown): void {
    if (isDebug()) {
      console.error(`[FileChurn] discovery store ${op} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
