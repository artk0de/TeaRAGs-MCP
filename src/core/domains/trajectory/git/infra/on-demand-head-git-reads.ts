/**
 * The whole-repository reads an on-demand computation needs that depend on
 * nothing but (repository, HEAD) — read once per HEAD instead of once per
 * computation (bd tea-rags-mcp-89k7k.35.23, 89k7k.35.24):
 * - the lifetime walk (`readFileLifetimeStamps`, one repo-wide
 *   `git log --name-status`) a path the file window holds nothing for needs;
 * - the HEAD commit's committer time (`resolveHistoryAnchorSec`, one
 *   `git log -1 %ct`) an `anchor: head` config measures every window from.
 *
 * Shaped as `GitEnrichmentProvider#getRunLifetime` / `#getRunHistoryAnchor`
 * memoize the same reads for a run: the PROMISE is kept, so concurrent callers
 * share one read; a failed read is dropped, so the next caller reads again;
 * a new HEAD replaces the repository's entry, both reads at once. The walk is
 * NOT skipped for a path HEAD does not hold: `foldFileLifetimeStamps` keys by
 * path, so an untracked file at a deleted path inherits that path's stamps in
 * ingest too — parity, kept.
 *
 * Owned by a long-lived caller (the working-tree git signal source); the
 * computation itself stays per call (`buildOnDemandGitSignals`).
 */

import type { VcsGitAdapter } from "../../../../adapters/vcs/index.js";
import { resolveHistoryAnchorSec } from "../history/index.js";
import { readFileLifetimeStamps, type FileLifetimeStamps } from "./file-lifetime.js";

/** Repositories kept — one entry each, for the HEAD it was last read at. */
const DEFAULT_REPOSITORY_CAPACITY = 16;

/** One repository's reads at one HEAD; a slot is filled on its first read. */
interface OnDemandHeadGitReadEntry {
  readonly head: string;
  fileLifetimeStamps?: Promise<Map<string, FileLifetimeStamps>>;
  historyAnchorSec?: Promise<number | undefined>;
}

export class OnDemandHeadGitReadMemo {
  /** By repository root, least recently used first. */
  private readonly entries = new Map<string, OnDemandHeadGitReadEntry>();

  constructor(private readonly capacity: number = DEFAULT_REPOSITORY_CAPACITY) {}

  /** Whole-history age stamps of every path HEAD's history touched; rejects when the walk fails. */
  async fileLifetimeStamps(
    adapter: VcsGitAdapter,
    head: string,
    timeoutMs: number,
  ): Promise<Map<string, FileLifetimeStamps>> {
    const entry = this.entryAt(adapter.repoRoot, head);
    if (entry.fileLifetimeStamps) return entry.fileLifetimeStamps;
    const read = readFileLifetimeStamps(adapter, timeoutMs);
    entry.fileLifetimeStamps = read;
    void read.catch(() => {
      if (entry.fileLifetimeStamps === read) delete entry.fileLifetimeStamps;
    });
    return read;
  }

  /** The HEAD commit's committer time, unix seconds; `undefined` (not kept) when unreadable. */
  async historyAnchorSec(adapter: VcsGitAdapter, head: string, timeoutMs: number): Promise<number | undefined> {
    const entry = this.entryAt(adapter.repoRoot, head);
    if (entry.historyAnchorSec) return entry.historyAnchorSec;
    const read = resolveHistoryAnchorSec(adapter, "head", timeoutMs);
    entry.historyAnchorSec = read;
    void read.then((anchorSec) => {
      if (anchorSec === undefined && entry.historyAnchorSec === read) delete entry.historyAnchorSec;
    });
    return read;
  }

  /** The repository's entry at `head` — a fresh one when it was last read at another HEAD. */
  private entryAt(repoRoot: string, head: string): OnDemandHeadGitReadEntry {
    const known = this.entries.get(repoRoot);
    const entry = known?.head === head ? known : { head };
    this.entries.delete(repoRoot);
    this.entries.set(repoRoot, entry);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
    return entry;
  }
}
