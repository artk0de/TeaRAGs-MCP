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
 * `pre{old => new}post` column (bd tea-rags-mcp-0dwsn). v2 stored the
 * `CommitChangedPath` pair instead, and v1 was upgraded on load because the
 * string carried both paths. v3 (bd tea-rags-mcp-dm61n) adds each row's numstat
 * `added` / `deleted` line counts, which the co-change build persists per
 * bundle file. Neither v1 nor v2 holds those counts and they cannot be derived
 * from the file without git, so `.claude/rules/migrations.md`'s "computable from
 * what is stored → migrate" does not apply: a v1 or v2 snapshot loads as null
 * and the discovery runs ONE full `git log --numstat` rebuild, then saves v3.
 * That costs a git walk, never a reindex. Size: the counts add ~24 bytes per
 * changed-file row — measured on taxdome's v2 snapshot (26.6 MB, 164k rows)
 * that is ~+4 MB, well under the 64 MB cap. This
 * store is keyed by repo IDENTITY, not by collection, so it is deliberately NOT
 * one of the five collection-scoped migration pipelines that rule tabulates.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isDebug } from "../../../../primitives/diagnostics/index.js";
import type {
  GitCommitDiscoveryEntry,
  GitCommitDiscoveryPersistence,
  PersistedGitCommitDiscovery,
} from "./commit-discovery.js";
import { mailmapStampMatches, readMailmapFingerprint } from "./mailmap-fingerprint.js";
import { resolveRepoIdentity } from "./repo-identity.js";
import { pruneSnapshots } from "./snapshot-retention.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Schema version this store writes and the only one it reads. */
const CURRENT_VERSION = 3;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

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

/** Cheap structural validation of one v3 matrix row (<5ms at 50k entries). */
function isValidEntry(value: unknown): value is GitCommitDiscoveryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { commit?: unknown; changedFiles?: unknown };
  if (!Array.isArray(entry.changedFiles)) return false;
  for (const changed of entry.changedFiles) {
    if (typeof changed !== "object" || changed === null) return false;
    const { path, previousPath, added, deleted } = changed as Record<string, unknown>;
    if (typeof path !== "string") return false;
    if (previousPath !== undefined && typeof previousPath !== "string") return false;
    if (!isOptionalCount(added) || !isOptionalCount(deleted)) return false;
  }
  return isValidCommit(entry.commit);
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
    const mailmap = readMailmapFingerprint(repoRoot);
    const hit = this.read(join(this.repoDir(identity), `${head}.json`), identity, mailmap, head);
    if (hit || identity === repoRoot) return hit;
    return this.read(join(this.repoDir(repoRoot), `${head}.json`), repoRoot, mailmap, head);
  }

  loadLatest(repoRoot: string): PersistedGitCommitDiscovery | null {
    const identity = resolveRepoIdentity(repoRoot);
    const mailmap = readMailmapFingerprint(repoRoot);
    const hit = this.readLatest(identity, mailmap);
    if (hit || identity === repoRoot) return hit;
    return this.readLatest(repoRoot, mailmap);
  }

  private readLatest(identity: string, mailmap: string): PersistedGitCommitDiscovery | null {
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
      return this.read(join(dir, newest), identity, mailmap);
    } catch (error) {
      this.debugLog("loadLatest", error);
      return null;
    }
  }

  save(repoRoot: string, head: string, sinceIso: string, entries: GitCommitDiscoveryEntry[]): void {
    try {
      const identity = resolveRepoIdentity(repoRoot);
      const mailmap = readMailmapFingerprint(repoRoot);
      const payload: PersistedGitCommitDiscovery = {
        version: CURRENT_VERSION,
        repoRoot: identity,
        head,
        sinceIso,
        entries,
        ...(mailmap !== "" ? { mailmap } : {}),
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

  private read(filePath: string, repoRoot: string, mailmap: string, head?: string): PersistedGitCommitDiscovery | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const snapshot = this.validate(parsed, repoRoot, mailmap, head);
      return snapshot;
    } catch (error) {
      this.debugLog("load", error);
      return null;
    }
  }

  /**
   * ANY validation failure → null (silent rebuild semantics). The repoRoot
   * equality check guards against sha256-prefix collisions between repos. A v1
   * or v2 payload is rejected too — it holds no line counts (module docblock).
   */
  private validate(
    parsed: unknown,
    repoRoot: string,
    mailmap: string,
    head?: string,
  ): PersistedGitCommitDiscovery | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as Record<string, unknown>;
    if (snapshot.version !== CURRENT_VERSION) return null;
    if (snapshot.repoRoot !== repoRoot) return null;
    // Authors were read under another .mailmap → stale identities (bd tea-rags-mcp-nsxzh).
    if (!mailmapStampMatches(snapshot.mailmap, mailmap)) return null;
    if (typeof snapshot.head !== "string" || (head !== undefined && snapshot.head !== head)) return null;
    if (typeof snapshot.sinceIso !== "string") return null;
    const { entries } = snapshot;
    if (!Array.isArray(entries) || !entries.every(isValidEntry)) return null;

    return {
      version: CURRENT_VERSION,
      repoRoot,
      head: snapshot.head,
      sinceIso: snapshot.sinceIso,
      entries,
      ...(mailmap !== "" ? { mailmap } : {}),
    };
  }

  private debugLog(op: string, error: unknown): void {
    if (isDebug()) {
      console.error(`[ChunkChurn] discovery store ${op} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
