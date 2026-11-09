/**
 * bd tea-rags-mcp-61gt2 — persistent tier of the whole-history file-lifetime
 * stamps.
 *
 * The lifetime read is the one git pass the streaming file phase runs WITHOUT
 * an on-disk cache: `git log HEAD -M --name-status` over the whole history of
 * a monolith (23 s warm / minutes cold on taxdome's 200k commits), inside the
 * run's `logTimeoutMs` stall guard. Under streaming load the guard killed it,
 * the catch folded an EMPTY stamps map, and every dormant file of the racing
 * batches fell to the backfill — the chronic "~800 missed files" tail. The
 * stamps change only when commits land, so they persist here keyed by repo
 * identity plus the HEAD tip they were folded through; the next run tops the
 * cache up with `tip..HEAD` instead of re-walking history, and a same-HEAD
 * rerun reads no git at all.
 *
 * Same persistence discipline as GitBlameStore (atomic tmp+rename, oversized →
 * skip save, ANY load/validation failure → null silent rebuild, sync node:fs,
 * sha256(repoIdentity).slice(16) repo dir), with the same placement rule: a
 * SIBLING of git-discovery/, never inside it — the discovery store's
 * stale-HEAD sweep unlinks every other *.json in its own repo dir on save.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveRepoIdentity } from "../history/index.js";
import type { FileLifetimeStamps } from "./file-lifetime.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** On-disk shape v1 — the HEAD tip the fold stopped at, plus the stamps. */
interface PersistedFileLifetime {
  version: 1;
  /** Repo IDENTITY (shared git dir), not the working tree — mirrors GitBlameStore. */
  repoRoot: string;
  /** HEAD sha the stamps were folded through; `` = folded but tip unknown. */
  tip: string;
  stamps: Record<string, FileLifetimeStamps>;
}

export interface FileLifetimeSnapshot {
  readonly tip: string;
  readonly stamps: Map<string, FileLifetimeStamps>;
}

export class GitFileLifetimeStore {
  private readonly baseDir: string;

  constructor(
    baseDir?: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    this.baseDir = baseDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "file-lifetime");
  }

  /** Load the repo's persisted lifetime stamps; null on ANY failure (silent rebuild). */
  load(repoRoot: string): FileLifetimeSnapshot | null {
    const identity = resolveRepoIdentity(repoRoot);
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.lifetimePath(identity), "utf8"));
      const snapshot = this.validate(parsed, identity);
      if (!snapshot) return null;
      const stamps = new Map<string, FileLifetimeStamps>();
      for (const [path, stamp] of Object.entries(snapshot.stamps)) stamps.set(path, { ...stamp });
      return { tip: snapshot.tip, stamps };
    } catch {
      return null;
    }
  }

  /** Persist the stamps best-effort: failures only cost the next run a rebuild. */
  save(repoRoot: string, tip: string, stamps: ReadonlyMap<string, FileLifetimeStamps>): void {
    try {
      const identity = resolveRepoIdentity(repoRoot);
      const payload: PersistedFileLifetime = {
        version: 1,
        repoRoot: identity,
        tip,
        stamps: Object.fromEntries(stamps),
      };
      const data = JSON.stringify(payload);
      // Oversized stamps → skip persistence; the run keeps its in-memory copy.
      if (Buffer.byteLength(data) > this.maxBytes) return;

      const target = this.lifetimePath(identity);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, target); // atomic replace
    } catch {
      // Best-effort persistence: a failed save only costs the next run a rebuild.
    }
  }

  private lifetimePath(identity: string): string {
    return join(this.baseDir, createHash("sha256").update(identity).digest("hex").slice(0, 16), "lifetime.json");
  }

  private validate(parsed: unknown, identity: string): PersistedFileLifetime | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as Record<string, unknown>;
    if (snapshot.version !== 1) return null;
    if (snapshot.repoRoot !== identity) return null;
    if (typeof snapshot.tip !== "string") return null;
    if (typeof snapshot.stamps !== "object" || snapshot.stamps === null) return null;
    for (const stamp of Object.values(snapshot.stamps as Record<string, unknown>)) {
      if (typeof stamp !== "object" || stamp === null) return null;
      const entry = stamp as Record<string, unknown>;
      if (typeof entry.lastModifiedAt !== "number") return null;
      if (typeof entry.firstCreatedAt !== "number") return null;
      if (typeof entry.lastCommitHash !== "string") return null;
    }
    return snapshot as unknown as PersistedFileLifetime;
  }
}
