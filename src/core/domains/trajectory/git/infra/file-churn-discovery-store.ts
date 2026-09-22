/**
 * Persistent tier of the file-churn discovery cache — the numstat-preserving
 * sibling of GitCommitDiscoveryStore.
 *
 * Layout: `<baseDir>/<sha256(identity).hex.slice(0,16)>/<head>.json` — keyed by
 * repo IDENTITY (the shared git dir, see repo-identity.ts): git history is a
 * repo property shared across every collection indexing that repo, and across
 * every working tree over its object database. Several HEADs coexist in one
 * directory — a checkout and its linked worktrees each persist their own — so
 * `save` retains the newest few (see snapshot-retention.ts) rather than dropping
 * every other file; that retention IS the size cap. Reads fall back to the
 * pre-identity per-working-tree layout so warm caches survive the upgrade.
 *
 * The baseDir subdir (`file-churn-discovery`) is DISTINCT from the chunk
 * matrix's `git-discovery`, so the two snapshots never collide — critical
 * because each store's `save` prunes `*.json` in its own repoDir.
 *
 * Everything is best-effort: corrupt / mismatched / oversized payloads degrade
 * silently to null so the discovery rebuilds from git. Sync node:fs APIs by
 * precedent (commit-discovery-store.ts, infra/registry/registry-file.ts).
 *
 * SCHEMA VERSIONS. v1 persisted `files[].path` straight out of
 * `git log --numstat`, so a renamed file aggregated under git's mangled
 * `pre{old => new}post` column instead of under the file it names
 * (bd tea-rags-mcp-0dwsn). v2 stores the `CommitChangedPath` pair alongside the
 * +/- counts. The mangled string carries both paths, so the v1 → v2 transform
 * needs no git call and, per `.claude/rules/migrations.md`, ships as a
 * migration rather than an invalidation: a v1 snapshot is upgraded on load and
 * rewritten at v2. Like its sibling this store is repo-identity-scoped, not
 * collection-scoped, so it is not one of that rule's five pipelines — its
 * upgrade path belongs in this loader.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseNumstatChangedPath } from "../../../../adapters/vcs/git/git-cli/parsers.js";
import type { CommitFileNumstat } from "../../../../adapters/vcs/types.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { FileChurnDiscoveryPersistence, PersistedFileChurnDiscovery } from "./file-churn-discovery.js";
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

/** Counts half of a numstat row — version-independent. */
function hasValidCounts(file: unknown): file is Record<string, unknown> {
  if (typeof file !== "object" || file === null) return false;
  const f = file as Record<string, unknown>;
  return typeof f.added === "number" && typeof f.deleted === "number";
}

/** Cheap structural validation of one v2 file-churn entry. */
function isValidEntry(value: unknown): value is CommitFileNumstat {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { commit?: unknown; committerTimestamp?: unknown; files?: unknown };
  // A snapshot written before committer-date windowing lacks this field —
  // reject it so the discovery rebuilds rather than evicting by `undefined`.
  if (typeof entry.committerTimestamp !== "number") return false;
  if (!Array.isArray(entry.files)) return false;
  for (const file of entry.files) {
    if (!hasValidCounts(file)) return false;
    if (typeof file.path !== "string") return false;
    if (file.previousPath !== undefined && typeof file.previousPath !== "string") return false;
  }
  return isValidCommit(entry.commit);
}

/**
 * v1 → v2: each raw numstat `path` string becomes a `CommitChangedPath`, counts
 * untouched. Lossless and git-free, and it reuses the LIVE parser so upgraded
 * rows are byte-for-byte what a fresh `git log` parse would produce.
 * Returns null when a row is not a valid v1 row, which degrades to a rebuild.
 */
function upgradeFileChurnEntries(value: unknown): CommitFileNumstat[] | null {
  if (!Array.isArray(value)) return null;
  const upgraded: CommitFileNumstat[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { commit, committerTimestamp, files } = entry as {
      commit?: unknown;
      committerTimestamp?: unknown;
      files?: unknown;
    };
    if (typeof committerTimestamp !== "number" || !Array.isArray(files) || !isValidCommit(commit)) return null;
    const upgradedFiles: CommitFileNumstat["files"] = [];
    for (const file of files) {
      if (!hasValidCounts(file) || typeof file.path !== "string") return null;
      upgradedFiles.push({
        ...parseNumstatChangedPath(file.path),
        added: file.added as number,
        deleted: file.deleted as number,
      });
    }
    upgraded.push({ commit: commit as CommitFileNumstat["commit"], committerTimestamp, files: upgradedFiles });
  }
  return upgraded;
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
    const identity = resolveRepoIdentity(repoRoot);
    const hit = this.read(join(this.repoDir(identity), `${head}.json`), identity, head);
    if (hit || identity === repoRoot) return hit;
    return this.read(join(this.repoDir(repoRoot), `${head}.json`), repoRoot, head);
  }

  loadLatest(repoRoot: string): PersistedFileChurnDiscovery | null {
    const identity = resolveRepoIdentity(repoRoot);
    const hit = this.readLatest(identity);
    if (hit || identity === repoRoot) return hit;
    return this.readLatest(repoRoot);
  }

  private readLatest(identity: string): PersistedFileChurnDiscovery | null {
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

  save(repoRoot: string, head: string, sinceIso: string, entries: CommitFileNumstat[]): void {
    try {
      const identity = resolveRepoIdentity(repoRoot);
      const payload: PersistedFileChurnDiscovery = {
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
  private writeSnapshot(target: string, payload: PersistedFileChurnDiscovery): boolean {
    const data = JSON.stringify(payload);
    // Oversized window → skip persistence; the run keeps its in-memory copy.
    if (Buffer.byteLength(data) > this.maxBytes) return false;
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, target); // atomic replace
    return true;
  }

  private repoDir(repoRoot: string): string {
    return join(this.baseDir, createHash("sha256").update(repoRoot).digest("hex").slice(0, 16));
  }

  private read(filePath: string, repoRoot: string, head?: string): PersistedFileChurnDiscovery | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const snapshot = this.validate(parsed, repoRoot, head);
      if (!snapshot) return null;
      // A v1 file was just migrated in memory — persist the v2 form over the
      // same path so the transform runs once, not on every load.
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
  private validate(parsed: unknown, repoRoot: string, head?: string): PersistedFileChurnDiscovery | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as Record<string, unknown>;
    const { version } = snapshot;
    if (version !== 1 && version !== CURRENT_VERSION) return null;
    if (snapshot.repoRoot !== repoRoot) return null;
    if (typeof snapshot.head !== "string" || (head !== undefined && snapshot.head !== head)) return null;
    if (typeof snapshot.sinceIso !== "string") return null;

    const entries =
      version === 1
        ? upgradeFileChurnEntries(snapshot.entries)
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
      console.error(`[FileChurn] discovery store ${op} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
