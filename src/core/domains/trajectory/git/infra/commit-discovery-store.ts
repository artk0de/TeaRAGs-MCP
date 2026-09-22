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
 *
 * SCHEMA VERSIONS. v1 persisted `changedFiles: string[]` straight out of
 * `git log --numstat`, so every renamed file sat on disk as git's mangled
 * `pre{old => new}post` column (bd tea-rags-mcp-0dwsn). v2 stores the
 * `CommitChangedPath` pair instead. Per `.claude/rules/migrations.md` a shape
 * change to a persisted store ships with its upgrade path, and since the v1
 * string CONTAINS both paths the transform is computable from the file alone —
 * so a v1 snapshot is upgraded on load and rewritten at v2, never discarded and
 * never turned into "please reindex". This store is keyed by repo IDENTITY, not
 * by collection, so it is deliberately NOT one of the five collection-scoped
 * migration pipelines that rule tabulates; for a store outside them, "the store
 * and its upgrade path land together" means the upgrade lives in this loader.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseNumstatChangedPath } from "../../../../adapters/vcs/git/git-cli/parsers.js";
import { isDebug } from "../../../../infra/runtime.js";
import type {
  GitCommitDiscoveryEntry,
  GitCommitDiscoveryPersistence,
  PersistedGitCommitDiscovery,
} from "./commit-discovery.js";
import { resolveRepoIdentity } from "./repo-identity.js";
import { pruneSnapshots } from "./snapshot-retention.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Schema version this store writes; v1 is accepted and upgraded on load. */
const CURRENT_VERSION = 2;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** The commit half is version-independent — validated once for both shapes. */
function isValidCommit(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const commit = value as Record<string, unknown>;
  return (
    typeof commit.sha === "string" &&
    typeof commit.author === "string" &&
    typeof commit.authorEmail === "string" &&
    typeof commit.body === "string" &&
    typeof commit.timestamp === "number" &&
    isStringArray(commit.parents)
  );
}

/** Cheap structural validation of one v2 matrix row (<5ms at 50k entries). */
function isValidEntry(value: unknown): value is GitCommitDiscoveryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { commit?: unknown; changedFiles?: unknown };
  if (!Array.isArray(entry.changedFiles)) return false;
  for (const changed of entry.changedFiles) {
    if (typeof changed !== "object" || changed === null) return false;
    const { path, previousPath } = changed as Record<string, unknown>;
    if (typeof path !== "string") return false;
    if (previousPath !== undefined && typeof previousPath !== "string") return false;
  }
  return isValidCommit(entry.commit);
}

/**
 * v1 → v2: each raw numstat string becomes a `CommitChangedPath`. Lossless —
 * git's `pre{old => new}post` column carries both paths, so no git call is
 * needed. Deliberately reuses the LIVE parser: a second implementation would
 * drift and upgraded rows would stop matching freshly parsed ones.
 * Returns null when a row is not a valid v1 row, which degrades to a rebuild.
 */
function upgradeCommitDiscoveryEntries(value: unknown): GitCommitDiscoveryEntry[] | null {
  if (!Array.isArray(value)) return null;
  const upgraded: GitCommitDiscoveryEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { commit, changedFiles } = entry as { commit?: unknown; changedFiles?: unknown };
    if (!isStringArray(changedFiles) || !isValidCommit(commit)) return null;
    upgraded.push({
      commit: commit as GitCommitDiscoveryEntry["commit"],
      changedFiles: changedFiles.map(parseNumstatChangedPath),
    });
  }
  return upgraded;
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
      const payload: PersistedGitCommitDiscovery = {
        version: CURRENT_VERSION,
        repoRoot: identity,
        head,
        sinceIso,
        entries,
      };
      const dir = this.repoDir(identity);
      mkdirSync(dir, { recursive: true });
      if (!this.writeSnapshot(join(dir, `${head}.json`), payload)) return;

      pruneSnapshots(dir);
    } catch (error) {
      // Best-effort persistence: a failed save only costs the next run a log.
      this.debugLog("save", error);
    }
  }

  /** Atomic tmp+rename write; false when the payload exceeds the size cap. */
  private writeSnapshot(target: string, payload: PersistedGitCommitDiscovery): boolean {
    const data = JSON.stringify(payload);
    // Oversized matrix → skip persistence; the run keeps its in-memory copy.
    if (Buffer.byteLength(data) > this.maxBytes) return false;
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, target); // atomic replace
    return true;
  }

  private repoDir(repoRoot: string): string {
    return join(this.baseDir, createHash("sha256").update(repoRoot).digest("hex").slice(0, 16));
  }

  private read(filePath: string, repoRoot: string, head?: string): PersistedGitCommitDiscovery | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const snapshot = this.validate(parsed, repoRoot, head);
      if (!snapshot) return null;
      // A v1 file was just migrated in memory — persist the v2 form over the
      // same path so the transform runs once, not on every load. Best-effort:
      // a read-only cache dir still yields a correct upgraded snapshot.
      if ((parsed as { version?: unknown }).version !== CURRENT_VERSION) {
        try {
          this.writeSnapshot(filePath, snapshot);
        } catch (error) {
          this.debugLog("upgrade", error);
        }
      }
      return snapshot;
    } catch (error) {
      this.debugLog("load", error);
      return null;
    }
  }

  /**
   * ANY validation failure → null (silent rebuild semantics). The repoRoot
   * equality check guards against sha256-prefix collisions between repos. A v1
   * payload is UPGRADED here rather than rejected — see the module docblock.
   */
  private validate(parsed: unknown, repoRoot: string, head?: string): PersistedGitCommitDiscovery | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as Record<string, unknown>;
    const { version } = snapshot;
    if (version !== 1 && version !== CURRENT_VERSION) return null;
    if (snapshot.repoRoot !== repoRoot) return null;
    if (typeof snapshot.head !== "string" || (head !== undefined && snapshot.head !== head)) return null;
    if (typeof snapshot.sinceIso !== "string") return null;

    const entries =
      version === 1
        ? upgradeCommitDiscoveryEntries(snapshot.entries)
        : Array.isArray(snapshot.entries) && snapshot.entries.every(isValidEntry)
          ? snapshot.entries
          : null;
    if (!entries) return null;

    return {
      version: CURRENT_VERSION,
      repoRoot,
      head: snapshot.head,
      sinceIso: snapshot.sinceIso,
      entries,
    };
  }

  private debugLog(op: string, error: unknown): void {
    if (isDebug()) {
      console.error(`[ChunkChurn] discovery store ${op} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
