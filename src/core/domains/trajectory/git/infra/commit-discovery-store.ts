/**
 * bd tea-rags-mcp-82va1 — persistent tier of the commit-discovery matrix.
 *
 * Layout: `<baseDir>/<sha256(identity).hex.slice(0,16)>/<head>.json` — keyed by
 * repo IDENTITY (the shared git dir, see repo-identity.ts), NOT collection: git
 * history is a repo property shared across every collection indexing that repo,
 * and across every working tree over its object database (documented deviation
 * from the bd comment's "<collectionHash>" example). Several HEADs coexist in
 * one directory — a checkout and its linked worktrees each persist their own —
 * so `save` retains the newest few (see snapshot-retention.ts) rather than
 * dropping every other file; that retention IS the size cap. Reads fall back to
 * the pre-identity per-working-tree layout so warm caches survive the upgrade.
 *
 * Everything is best-effort: corrupt / mismatched / oversized payloads
 * degrade silently to null so the discovery rebuilds from git. Sync node:fs
 * APIs by precedent (infra/registry/registry-file.ts).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isDebug } from "../../../../infra/runtime.js";
import type {
  GitCommitDiscoveryEntry,
  GitCommitDiscoveryPersistence,
  PersistedGitCommitDiscovery,
} from "./commit-discovery.js";
import { resolveRepoIdentity } from "./repo-identity.js";
import { pruneSnapshots } from "./snapshot-retention.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Cheap structural validation of one matrix row (<5ms at 50k entries). */
function isValidEntry(value: unknown): value is GitCommitDiscoveryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { commit?: unknown; changedFiles?: unknown };
  if (!isStringArray(entry.changedFiles)) return false;
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

export class GitCommitDiscoveryStore implements GitCommitDiscoveryPersistence {
  private readonly baseDir: string;

  constructor(
    baseDir?: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    // Existing repo convention for app data (adapters/qdrant/embedded/download.ts).
    this.baseDir = baseDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "git-discovery");
  }

  load(repoRoot: string, head: string): PersistedGitCommitDiscovery | null {
    const identity = resolveRepoIdentity(repoRoot);
    const hit = this.read(join(this.repoDir(identity), `${head}.json`), identity, head);
    if (hit || identity === repoRoot) return hit;
    return this.read(join(this.repoDir(repoRoot), `${head}.json`), repoRoot, head);
  }

  loadLatest(repoRoot: string): PersistedGitCommitDiscovery | null {
    const identity = resolveRepoIdentity(repoRoot);
    const hit = this.readLatest(identity);
    if (hit || identity === repoRoot) return hit;
    return this.readLatest(repoRoot);
  }

  private readLatest(identity: string): PersistedGitCommitDiscovery | null {
    try {
      const dir = this.repoDir(identity);
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
      return this.read(join(dir, newest), identity);
    } catch (error) {
      this.debugLog("loadLatest", error);
      return null;
    }
  }

  save(repoRoot: string, head: string, sinceIso: string, entries: GitCommitDiscoveryEntry[]): void {
    try {
      const identity = resolveRepoIdentity(repoRoot);
      const payload: PersistedGitCommitDiscovery = { version: 1, repoRoot: identity, head, sinceIso, entries };
      const data = JSON.stringify(payload);
      // Oversized matrix → skip persistence; the run keeps its in-memory copy.
      if (Buffer.byteLength(data) > this.maxBytes) return;

      const dir = this.repoDir(identity);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${head}.json`);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, target); // atomic replace

      pruneSnapshots(dir);
    } catch (error) {
      // Best-effort persistence: a failed save only costs the next run a log.
      this.debugLog("save", error);
    }
  }

  private repoDir(repoRoot: string): string {
    return join(this.baseDir, createHash("sha256").update(repoRoot).digest("hex").slice(0, 16));
  }

  private read(filePath: string, repoRoot: string, head?: string): PersistedGitCommitDiscovery | null {
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
  private validate(parsed: unknown, repoRoot: string, head?: string): PersistedGitCommitDiscovery | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as Record<string, unknown>;
    if (snapshot.version !== 1) return null;
    if (snapshot.repoRoot !== repoRoot) return null;
    if (typeof snapshot.head !== "string" || (head !== undefined && snapshot.head !== head)) return null;
    if (typeof snapshot.sinceIso !== "string") return null;
    if (!Array.isArray(snapshot.entries) || !snapshot.entries.every(isValidEntry)) return null;
    return snapshot as unknown as PersistedGitCommitDiscovery;
  }

  private debugLog(op: string, error: unknown): void {
    if (isDebug()) {
      console.error(`[ChunkChurn] discovery store ${op} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
