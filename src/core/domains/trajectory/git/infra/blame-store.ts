/**
 * bd tea-rags-mcp-v2mlw — persistent tier of the OID-keyed blame cache.
 *
 * Same persistence discipline as GitCommitDiscoveryStore (atomic tmp+rename,
 * oversized → skip save, ANY load/validation failure → null silent rebuild,
 * sync node:fs, sha256(repoRoot).slice(0,16) repo dir), with three deliberate
 * DIFFERENCES:
 *
 *   1. baseDir = <data dir>/git-blame — a SIBLING of git-discovery/, NOT the
 *      same dir: the discovery store's stale-HEAD sweep unlinks every other
 *      *.json inside its own repo dir on save and would delete the blame file.
 *   2. ONE file per repo (`<baseDir>/<hash16>/blame.json`), NOT HEAD-keyed —
 *      entries are keyed by file blob OID and deliberately survive HEAD moves
 *      (that is the whole point: an unchanged file's blame is valid across
 *      commits). No stale-file sweep needed — the single file IS the size
 *      story, plus the maxBytes skip-save cap.
 *   3. Persisted shape is NORMALIZED: blame lines are bulky, and one commit's
 *      author/email/timestamp repeats on every line it owns — the commit
 *      table dedupes them per sha (~5x smaller than raw BlameLine[] JSON).
 *      DEFAULT_MAX_BYTES is doubled vs the discovery store (128 MB): blame is
 *      heavier than the commit matrix even normalized.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { BlameLine } from "../../../../adapters/vcs/types.js";
import { isDebug } from "../../../../infra/runtime.js";
import { resolveRepoIdentity } from "./repo-identity.js";

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

/** On-disk shape v1 — commit table + per-file [lineNumber, sha] pairs. */
interface PersistedGitBlame {
  version: 1;
  /**
   * Repo IDENTITY, not the working tree: the shared git dir when git can
   * resolve it, else the path handed in. Linked worktrees of one repo share
   * an object database, so they resolve to the same value and thus one cache
   * namespace. Files written before that fix carry a working-tree path here
   * and are still read via the legacy-layout fallback in `load`.
   */
  repoRoot: string;
  commits: Record<string, { author: string; authorEmail: string; timestamp: number }>;
  files: Record<string, { oid: string; lines: [lineNumber: number, sha: string][] }>;
}

function isValidCommitEntry(value: unknown): value is PersistedGitBlame["commits"][string] {
  if (typeof value !== "object" || value === null) return false;
  const commit = value as Record<string, unknown>;
  return (
    typeof commit.author === "string" && typeof commit.authorEmail === "string" && typeof commit.timestamp === "number"
  );
}

function isValidLinePair(value: unknown): value is [number, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "string";
}

export class GitBlameStore {
  private readonly baseDir: string;

  constructor(
    baseDir?: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    // Existing repo convention for app data (adapters/qdrant/embedded/download.ts).
    this.baseDir = baseDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "git-blame");
  }

  /**
   * Load the repo's persisted blame map; null on ANY failure (silent rebuild).
   *
   * Reads the shared-git-dir namespace first, then falls back to the pre-fix
   * per-working-tree layout so a cache warmed by an older release survives the
   * upgrade (on the next save it is rewritten under the shared identity).
   */
  load(repoRoot: string): Map<string, { oid: string; lines: BlameLine[] }> | null {
    const identity = resolveRepoIdentity(repoRoot);
    return this.read(identity) ?? (identity === repoRoot ? null : this.read(repoRoot));
  }

  private read(identity: string): Map<string, { oid: string; lines: BlameLine[] }> | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.blamePath(identity), "utf8"));
      const snapshot = this.validate(parsed, identity);
      if (!snapshot) return null;
      const result = new Map<string, { oid: string; lines: BlameLine[] }>();
      for (const [relPath, file] of Object.entries(snapshot.files)) {
        const lines: BlameLine[] = file.lines.map(([lineNumber, sha]) => {
          const commit = snapshot.commits[sha];
          return {
            lineNumber,
            sha,
            author: commit.author,
            authorEmail: commit.authorEmail,
            timestamp: commit.timestamp,
          };
        });
        result.set(relPath, { oid: file.oid, lines });
      }
      return result;
    } catch (error) {
      this.debugLog("load", error);
      return null;
    }
  }

  /** Persist the repo's blame map, normalized. Best-effort: failures only log. */
  save(repoRoot: string, files: ReadonlyMap<string, { oid: string; lines: BlameLine[] }>): void {
    try {
      const commits: PersistedGitBlame["commits"] = {};
      const persistedFiles: PersistedGitBlame["files"] = {};
      for (const [relPath, file] of files) {
        const lines: [number, string][] = [];
        for (const line of file.lines) {
          commits[line.sha] ??= { author: line.author, authorEmail: line.authorEmail, timestamp: line.timestamp };
          lines.push([line.lineNumber, line.sha]);
        }
        persistedFiles[relPath] = { oid: file.oid, lines };
      }
      const identity = resolveRepoIdentity(repoRoot);
      const payload: PersistedGitBlame = { version: 1, repoRoot: identity, commits, files: persistedFiles };
      const data = JSON.stringify(payload);
      // Oversized blame map → skip persistence; the run keeps its in-memory copy.
      if (Buffer.byteLength(data) > this.maxBytes) return;

      const target = this.blamePath(identity);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, target); // atomic replace
    } catch (error) {
      // Best-effort persistence: a failed save only costs the next run a rebuild.
      this.debugLog("save", error);
    }
  }

  private blamePath(identity: string): string {
    return join(this.baseDir, createHash("sha256").update(identity).digest("hex").slice(0, 16), "blame.json");
  }

  /**
   * ANY validation failure → null (silent rebuild semantics). The identity
   * equality check guards against sha256-prefix collisions between repos;
   * the referenced-sha check guards a truncated/hand-edited commit table.
   */
  private validate(parsed: unknown, identity: string): PersistedGitBlame | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as Record<string, unknown>;
    if (snapshot.version !== 1) return null;
    if (snapshot.repoRoot !== identity) return null;
    if (typeof snapshot.commits !== "object" || snapshot.commits === null) return null;
    if (typeof snapshot.files !== "object" || snapshot.files === null) return null;
    const commits = snapshot.commits as Record<string, unknown>;
    for (const commit of Object.values(commits)) {
      if (!isValidCommitEntry(commit)) return null;
    }
    for (const file of Object.values(snapshot.files as Record<string, unknown>)) {
      if (typeof file !== "object" || file === null) return null;
      const entry = file as Record<string, unknown>;
      if (typeof entry.oid !== "string") return null;
      if (!Array.isArray(entry.lines)) return null;
      for (const pair of entry.lines) {
        if (!isValidLinePair(pair)) return null;
        if (!(pair[1] in commits)) return null; // every referenced sha must resolve
      }
    }
    return snapshot as unknown as PersistedGitBlame;
  }

  private debugLog(op: string, error: unknown): void {
    if (isDebug()) {
      console.error(`[GitEnrich] blame store ${op} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
