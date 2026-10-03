/**
 * WorkingTreeOverlay (bd tea-rags-mcp-xi2r9.1) — the per-request view of the
 * tree a read answers for: its {@link WorkingTreeDelta} against the commit the
 * base index was built at, and the {@link WorkingTreeMarker} the answer carries.
 *
 * The marker is never omitted and `view` never throws: a tree that cannot be
 * measured — no commit stamp, an unknown commit, an index whose dirty files
 * are unknown, a git failure — still yields a marker, with `degraded` saying why and what fixes
 * it. A degraded view touches no path, so nothing is substituted or hidden.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type { CollectionEntry, RegistryGitState } from "../../../contracts/types/registry.js";
import {
  WORKING_TREE_WARM_WAIT_MS,
  type WorkingTree,
  type WorkingTreeBasePointTier,
  type WorkingTreeDeltaSignalSource,
  type WorkingTreeGraphReader,
  type WorkingTreeGraphRequest,
  type WorkingTreeGraphSource,
  type WorkingTreeGraphState,
  type WorkingTreeMarker,
  type WorkingTreeTouchedBasePointsByPath,
  type WorkingTreeTouchedBasePointsReader,
} from "../../../contracts/types/working-tree.js";
import { findGitToplevel, readRepoGitState } from "../../../infra/repo-git-state.js";
import type { ChunkerConfig } from "../../../types.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import type { WorkingTreeChunkLayer, WorkingTreeChunkLayerRead } from "./chunk-layer.js";
import { WORKING_TREE_REINDEX_REMEDY, type WorkingTreeDelta, type WorkingTreeDeltaReader } from "./delta.js";
import type { WorkingTreeDenseVectorReader, WorkingTreeDenseVectorSource } from "./dense-floor.js";
import { relativePathOf } from "./substitute.js";
import type { WorkingTreeDeltaWarmer, WorkingTreeDeltaWarmState } from "./warmer.js";
import type { WorkingTreeWatcher } from "./watcher.js";

export interface WorkingTreeView {
  marker: WorkingTreeMarker;
  /**
   * re-read changed ∪ deleted: the files whose base rows are replaced or
   * hidden. Empty when degraded (nothing substituted, nothing hidden).
   */
  touchedPaths: ReadonlySet<string>;
  deletedPaths: ReadonlySet<string>;
  /**
   * Changed files the tree changed but this view does not re-read (delta
   * admission declined them): their base rows stay in the answer, marked
   * `treeState: "modified"` (`workingTreeStateOf`). Disjoint from
   * `touchedPaths`. The overlay always sets it (empty when degraded); absent
   * on a hand-built view, where it reads as empty.
   */
  indexServedPaths?: ReadonlySet<string>;
  /**
   * Rows of the changed files as the chunker yields them — structure only, no
   * trajectory payload (deleted files have none). Absent on a degraded view and
   * when no chunk layer is wired. Chunked once per view; files that fail to
   * read or parse land in `marker.unparsed` when the returned promise resolves.
   */
  readDeltaChunks?: () => Promise<readonly ScrollChunk[]>;
  /**
   * `rows` with the trajectory payload ingest would have given them
   * (`WORKING_TREE_SIGNAL_PAYLOAD_KEYS`, WTO-6/7): every row that is one of
   * this view's delta rows (by id) gets its git / codegraph blocks merged over
   * its own payload; any other row comes back as it is. Rows are signalled per
   * FILE, each file at most once per view — so an answer pays git for the
   * files whose rows reach its candidates, never for the whole delta (live C1,
   * bd tea-rags-mcp-xi2r9: a 159-file delta blamed every file on a find_symbol
   * that answered one). Present when a signal source and a chunk layer are wired.
   */
  signalDeltaRows?: <R extends WorkingTreeSignalledRow>(rows: readonly R[]) => Promise<R[]>;
  /**
   * The tree's codegraph for this delta (WTO-7), waiting at most `waitMs`.
   * Present only for a measured non-empty delta with a graph source wired; the
   * build was already started when the view was made. Reading does not stamp
   * the marker — the reader that USES the graph does
   * (`recordTreeGraphState`), so an answer never claims a graph it did not read.
   */
  readTreeGraph?: WorkingTreeGraphReader;
  /**
   * The built tree graph a search/symbol LOOKUP of this answer read
   * (find_symbol's tree definitions and chunk hop, an outline's visibility —
   * `recordingTreeGraphReader`). Reading it does not claim the `codegraph`
   * floor: the strategy seam claims it once the answer returns a row of a file
   * the tree changed (`claimTreeGraphLookup`, D8) — a lookup that answered
   * nothing, or a row whose graph data is the index's, claims nothing.
   */
  treeGraphLookup?: WorkingTreeGraphState;
  /**
   * The base-index points of the touched files (bd tea-rags-mcp-xi2r9), by
   * tier and path, at the base index's revision: each consumer asks the minimum
   * it reads (hybrid's `has_id` exclusion light points of every touched path,
   * the dense floor light points of its missing rows' paths, the delta signals
   * full points of the signalled rows' paths); a path the view did not touch
   * reads nothing. Present only on a measured non-empty delta with a
   * base-point reader wired.
   */
  readTouchedBasePoints?: WorkingTreeTouchedBasePointsReader;
  /**
   * Which graph the delta rows' codegraph block came from, set once
   * `signalDeltaRows` enriched rows. Signalling rows does not stamp the marker
   * with it: whoever puts the rows into an answer does (`claimWorkingTreeFloors`,
   * the strategies' signal seam), D8.
   */
  deltaRowsTreeGraph?: WorkingTreeGraphState;
  /**
   * The delta rows' dense vectors (WTO-5), waiting at most `waitMs`. Present
   * only for a measured delta that changed files, with a chunk layer and a
   * dense source wired; the warm-up started when the view was made. Reading
   * does not stamp the marker — the strategy that SCORES rows by these vectors
   * does (`recordWorkingTreeDenseState`).
   */
  readDeltaVectors?: WorkingTreeDenseVectorReader;
  /**
   * The delta's moves: a changed path → the deleted path git pairs it with
   * (`WorkingTreeDelta#renamedFrom`). Present only on a measured delta that
   * moved a file — the tree counterpart of a base row of the old path lives at
   * the new one (`workingTreeCounterpartIds`).
   */
  renamedFrom?: ReadonlyMap<string, string>;
}

/** A row `signalDeltaRows` can be handed: a delta row, or an answer's hit carrying one's id. Without an id it is neither. */
export interface WorkingTreeSignalledRow {
  id?: string | number;
  payload?: Record<string, unknown>;
}

/**
 * The payload blocks `signalDeltaRows` adds to a delta row — the trajectories
 * whose payload the chunker never writes. A request filter naming a key under
 * one of them needs the rows signalled before it can admit them.
 */
export const WORKING_TREE_SIGNAL_PAYLOAD_KEYS = ["git", "codegraph"] as const;

/** Whether `filter` names a key only a signalled delta row carries. */
export function filterReadsWorkingTreeSignals(filter: unknown): boolean {
  if (Array.isArray(filter)) return filter.some(filterReadsWorkingTreeSignals);
  if (typeof filter !== "object" || filter === null) return false;
  return Object.entries(filter).some(([name, value]) =>
    name === "key" && typeof value === "string"
      ? WORKING_TREE_SIGNAL_PAYLOAD_KEYS.some((root) => value === root || value.startsWith(`${root}.`))
      : filterReadsWorkingTreeSignals(value),
  );
}

/** The overlay's port to the touched-file base points (`WorkingTreeTouchedBasePoints`). */
export interface WorkingTreeTouchedBasePointSource {
  pointsOf: (request: {
    collectionName: string;
    /** The registry's `indexedAt` of the base index; null when the index has no entry. */
    indexStamp: string | null;
    paths: Iterable<string>;
    tier: WorkingTreeBasePointTier;
  }) => Promise<WorkingTreeTouchedBasePointsByPath>;
}

/** How the overlay turns delta files into rows: the layer, and the config to chunk with. */
export interface WorkingTreeDeltaChunkSource {
  layer: WorkingTreeChunkLayer;
  /** The chunker config an index run on the tree's base index would chunk with. */
  resolveChunkerConfig: (tree: WorkingTree) => Promise<ChunkerConfig>;
}

/** The registry surface the overlay reads: an index's git stamp and alias. */
export interface WorkingTreeIndexLookup {
  get: (collectionName: string) => CollectionEntry | null | undefined;
}

export interface WorkingTreeOverlayDeps {
  registry: WorkingTreeIndexLookup;
  deltaReader: WorkingTreeDeltaReader;
  /** The ingest admission rule for files under `root` (`FileScanner#accepts`). */
  createFileFilter: (root: string) => Promise<(relativePath: string) => boolean>;
  /**
   * Delta admission: whether a CHANGED file is re-read from the tree (chunked,
   * vectorized, graphed). A declined file is served from the index and named in
   * `indexServedPaths`; deletions never ask. Absent → every changed file is
   * re-read.
   */
  admitsToDelta?: (relativePath: string) => boolean;
  /** Absent → views carry no `readDeltaChunks`. */
  deltaChunks?: WorkingTreeDeltaChunkSource;
  /** The tree-graph cache (WTO-7). Absent → views carry no `readTreeGraph` and nothing is warmed. */
  treeGraph?: WorkingTreeGraphSource;
  /**
   * Gives delta rows the git / codegraph payload ingest would have (WTO-6/7),
   * applied once inside `readDeltaChunks` so every consumer ranks enriched
   * rows. Absent → delta rows carry the chunk layer's structural payload only.
   */
  deltaSignals?: WorkingTreeDeltaSignalSource;
  /** Absent → views carry no `readTouchedBasePoints`. */
  touchedBasePoints?: WorkingTreeTouchedBasePointSource;
  /**
   * The dense floor's vector source (WTO-5). Present with `deltaChunks` → a
   * view that changed files warms its rows' vectors at view time and carries
   * `readDeltaVectors`.
   */
  denseVectors?: Pick<WorkingTreeDenseVectorSource, "warm">;
  /**
   * The per-process delta warm queue (WTO unbounded delta). Present with
   * `deltaChunks` → a view chunks its re-read files through it, waits at most
   * `warmWaitMs`, and serves the files not yet warm from the index
   * (`marker.pendingFiles`). Absent → the view chunks every re-read file
   * itself, on first read, with no bound on the wait.
   */
  warmer?: Pick<WorkingTreeDeltaWarmer, "warm">;
  /** Default {@link WORKING_TREE_WARM_WAIT_MS}. */
  warmWaitMs?: number;
  /**
   * Keeps a viewed linked tree warm between requests (the long-lived server
   * only): a view whose delta re-reads files hands it the tree's root. The base
   * index's own checkout is never watched.
   */
  watcher?: Pick<WorkingTreeWatcher, "watch">;
  /** How many viewed roots `prewarm` remembers; default {@link WORKING_TREE_VIEWED_TREES_KEPT}. */
  viewedTreesKept?: number;
}

const NO_TREE_REASON = "no working tree resolved for this index";
const NO_TREE_REMEDY = "pass path=<your working directory>";
const UNREADABLE_REMEDY = "check that {tree} is a readable git checkout";

const EMPTY_PATHS: ReadonlySet<string> = new Set();

/**
 * Roots `prewarm` remembers, the least recently viewed forgotten first. The
 * watcher stops a tree after 30 minutes without a view; this bounds a server
 * viewing many trees, where a forgotten root costs only its next view warming
 * on demand.
 */
export const WORKING_TREE_VIEWED_TREES_KEPT = 256;

/**
 * How far past its warm budget a view may wait for the warmer's own answer
 * before it stops waiting: the warmer answers at the budget, and its answer
 * reaches the view a few ticks later.
 */
const WORKING_TREE_WARM_GRACE_MS = 50;

/** A tree's measured delta, before any of it is read. */
interface WorkingTreeMeasuredDelta {
  kind: "measured";
  /** The marker with the delta's counts; floors empty. */
  marker: WorkingTreeMarker;
  delta: WorkingTreeDelta;
  deleted: readonly string[];
  /** Changed files re-read from the tree (delta admission). */
  reread: readonly string[];
  /** Changed files served from the index. */
  indexOnly: readonly string[];
  /** The registry's `indexedAt` of the base index — the revision its touched base points are read at. */
  indexStamp: string | null;
}

type WorkingTreeMeasurement = WorkingTreeMeasuredDelta | { kind: "degraded"; view: WorkingTreeView };

export class WorkingTreeOverlay {
  /** The last tree, and the alias it was named by, a view of each root saw — what `prewarm` re-measures. */
  private readonly viewed = new Map<string, { tree: WorkingTree; alias: string | undefined }>();

  constructor(private readonly deps: WorkingTreeOverlayDeps) {}

  /** Never throws for git trouble: a failure becomes `marker.degraded`. */
  async view(tree: WorkingTree, alias: string | undefined): Promise<WorkingTreeView> {
    if (tree.root !== "") this.remember(tree, alias);
    const measured = await this.measure(tree, alias);
    if (measured.kind === "degraded") return measured.view;
    const { collectionName } = tree.baseIndex;
    const { marker, delta, deleted, reread, indexOnly } = measured;
    const touched = reread.length + deleted.length;
    const source = this.deps.deltaChunks;
    const { warmer } = this.deps;
    // With a warmer, the rows are what it made ready within the budget; the
    // rest of the re-read files answer from the index this time.
    const warm = warmer && source && reread.length > 0 ? await this.warmLive(warmer, source, tree, reread) : undefined;
    const pending = warm?.pending ?? [];
    const view: WorkingTreeView = {
      marker: {
        ...marker,
        ...(indexOnly.length > 0 ? { indexOnlyFiles: indexOnly.length } : {}),
        ...(pending.length > 0 ? { pendingFiles: pending.length } : {}),
        ...(warm && warm.unparsed.length > 0 ? { unparsed: [...warm.unparsed] } : {}),
      },
      touchedPaths: new Set([...(warm ? reread.filter((path) => warm.warmPaths.has(path)) : reread), ...deleted]),
      deletedPaths: new Set(deleted),
      indexServedPaths: new Set([...indexOnly, ...pending]),
      ...(delta.renamedFrom && delta.renamedFrom.size > 0 ? { renamedFrom: delta.renamedFrom } : {}),
    };
    if (touched > 0 && this.deps.treeGraph) {
      view.readTreeGraph = treeGraphReader(this.deps.treeGraph, treeGraphRequestOf(tree, measured));
    }
    const { touchedBasePoints } = this.deps;
    if (touched > 0 && touchedBasePoints) {
      const { indexStamp } = measured;
      view.readTouchedBasePoints = async ({ tier, paths }) =>
        touchedBasePoints.pointsOf({
          collectionName,
          indexStamp,
          tier,
          paths: paths ? [...paths].filter((path) => view.touchedPaths.has(path)) : view.touchedPaths,
        });
    }
    if (source) {
      const { deltaSignals, denseVectors } = this.deps;
      let chunked: Promise<WorkingTreeChunkLayerRead> | undefined;
      const readChunked = async (): Promise<WorkingTreeChunkLayerRead> =>
        (chunked ??= warm
          ? Promise.resolve({ chunks: warm.rows, unparsed: warm.unparsed, storeKeys: warm.storeKeys })
          : readDeltaChunks(source, tree, reread, view.marker));
      view.readDeltaChunks = async () => (await readChunked()).chunks;
      if (deltaSignals) {
        view.signalDeltaRows = deltaRowSignaller(deltaSignals, tree, view, delta.renamedFrom);
      }
      if (denseVectors && reread.length > 0) {
        view.readDeltaVectors = warmDeltaVectors(denseVectors, collectionName, view, readChunked);
      }
    }
    if (reread.length > 0 && this.deps.watcher && !(await isBaseCheckout(tree))) {
      this.deps.watcher.watch(tree.root);
    }
    return view;
  }

  /** Records the tree `prewarm` re-measures for its root, as the most recently viewed. */
  private remember(tree: WorkingTree, alias: string | undefined): void {
    this.viewed.delete(tree.root);
    this.viewed.set(tree.root, { tree, alias });
    const kept = this.deps.viewedTreesKept ?? WORKING_TREE_VIEWED_TREES_KEPT;
    while (this.viewed.size > kept) {
      const oldest = this.viewed.keys().next().value;
      if (oldest === undefined) break;
      this.viewed.delete(oldest);
    }
  }

  /**
   * Re-measures the tree a view of `root` last saw and queues its re-read files
   * on the warmer's background lane, without waiting for them; starts the tree
   * graph's build for the delta it measured. A root no view has seen is a
   * no-op. Writes only the chunk store and the tree-graph cache, never the
   * index. Never throws.
   */
  async prewarm(root: string): Promise<void> {
    const seen = this.viewed.get(root);
    if (!seen) return;
    const { tree } = seen;
    const measured = await this.measure(tree, seen.alias);
    if (measured.kind === "degraded") return;
    const { reread, deleted } = measured;
    if (reread.length + deleted.length > 0 && this.deps.treeGraph) {
      // `graphFor` never rejects (port contract); the catch keeps a broken one from surfacing as unhandled.
      this.deps.treeGraph.graphFor(treeGraphRequestOf(tree, measured), 0).catch(() => undefined);
    }
    const { warmer, deltaChunks } = this.deps;
    if (!warmer || !deltaChunks || reread.length === 0) return;
    try {
      const config = await deltaChunks.resolveChunkerConfig(tree);
      const request = { treeRoot: tree.root, collectionName: tree.baseIndex.collectionName, config, paths: reread };
      warmer.warm(request, 0, "background").catch(() => undefined);
    } catch {
      // No chunker config now: the tree's next view warms it on demand.
    }
  }

  /**
   * The tree's delta against its base index, admitted into re-read and
   * index-only files, with the marker's counts. Never throws: anything that
   * cannot be measured is a degraded view.
   */
  private async measure(tree: WorkingTree, alias: string | undefined): Promise<WorkingTreeMeasurement> {
    const { collectionName } = tree.baseIndex;
    const entry = this.deps.registry.get(collectionName) ?? undefined;
    const indexedCommit = entry?.git?.indexedCommit ? entry.git.indexedCommit : null;
    const marker: WorkingTreeMarker = {
      tree: tree.root,
      indexedCommit,
      treeCommit: null,
      indexedDirty: entry?.git?.indexedDirty ?? false,
      changedFiles: 0,
      deletedFiles: 0,
      floors: [],
    };
    const fill = (template: string): string =>
      template.replaceAll("{alias}", alias ?? entry?.name ?? collectionName).replaceAll("{tree}", tree.root);
    const degraded = (reason: string, remedy: string): WorkingTreeMeasurement => ({
      kind: "degraded",
      view: {
        marker: { ...marker, degraded: { reason, remedy: fill(remedy) } },
        touchedPaths: EMPTY_PATHS,
        deletedPaths: EMPTY_PATHS,
        indexServedPaths: EMPTY_PATHS,
      },
    });

    if (tree.root === "") return degraded(NO_TREE_REASON, NO_TREE_REMEDY);
    try {
      // The tree root may sit below its git toplevel (an index registered at a
      // subdirectory), where `.git` is not; HEAD is the toplevel's.
      marker.treeCommit = readRepoGitState(findGitToplevel(tree.root) ?? tree.root)?.commit || null;
      const accepts = await this.deps.createFileFilter(tree.root);
      const read = await this.deps.deltaReader.read(tree.root, indexedCommit, accepts);
      if (read.kind === "degraded") return degraded(read.reason, read.remedy);
      const dirtyAtIndex = dirtyAtIndexTime(entry?.git);
      if (dirtyAtIndex.kind === "unknown") return degraded(dirtyAtIndex.reason, WORKING_TREE_REINDEX_REMEDY);
      const { changed, deleted } = await foldDirtyAtIndexTime(tree.root, read.delta, dirtyAtIndex.paths, accepts);
      // Delta admission: only `reread` is chunked, vectorized and graphed from
      // the tree; `indexOnly` keeps its base rows, marked "modified".
      const { admitsToDelta } = this.deps;
      const reread = admitsToDelta ? changed.filter((path) => admitsToDelta(path)) : changed;
      const indexOnly = admitsToDelta ? changed.filter((path) => !admitsToDelta(path)) : [];
      return {
        kind: "measured",
        marker: { ...marker, changedFiles: changed.length, deletedFiles: deleted.length },
        delta: read.delta,
        deleted,
        reread,
        indexOnly,
        indexStamp: entry?.indexedAt ? entry.indexedAt : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return degraded(`cannot read the working tree delta: ${message.split("\n")[0]}`, UNREADABLE_REMEDY);
    }
  }

  /**
   * The re-read files warmed on the live lane within the warm budget, counted
   * from the start (resolving the chunker config spends it too). A warmer that
   * fails, or has not answered by the budget plus a grace, leaves every file
   * pending — the view then answers them from the index. Never rejects.
   */
  private async warmLive(
    warmer: Pick<WorkingTreeDeltaWarmer, "warm">,
    source: WorkingTreeDeltaChunkSource,
    tree: WorkingTree,
    reread: readonly string[],
  ): Promise<WorkingTreeDeltaWarmState> {
    const allPending: WorkingTreeDeltaWarmState = {
      rows: [],
      warmPaths: EMPTY_PATHS,
      unparsed: [],
      pending: reread,
      storeKeys: new Map(),
    };
    const budgetMs = Math.max(0, this.deps.warmWaitMs ?? WORKING_TREE_WARM_WAIT_MS);
    const deadline = Date.now() + budgetMs;
    const warmed = (async () => {
      const config = await source.resolveChunkerConfig(tree);
      const request = { treeRoot: tree.root, collectionName: tree.baseIndex.collectionName, config, paths: reread };
      return warmer.warm(request, Math.max(0, deadline - Date.now()), "live");
    })().catch(() => allPending);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lapsed = new Promise<WorkingTreeDeltaWarmState>((resolveLapse) => {
      timer = setTimeout(() => {
        resolveLapse(allPending);
      }, budgetMs + WORKING_TREE_WARM_GRACE_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([warmed, lapsed]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Whether `tree` is the base index's own checkout — kept fresh by reindexing,
 * never watched. An index with no recorded root cannot be told apart from it.
 */
async function isBaseCheckout(tree: WorkingTree): Promise<boolean> {
  const baseRoot = tree.baseIndex.root;
  if (baseRoot === undefined) return true;
  const real = async (path: string): Promise<string> => fs.realpath(path).catch(() => resolve(path));
  const [treeReal, baseReal] = await Promise.all([real(tree.root), real(baseRoot)]);
  return treeReal === baseReal;
}

/** The tree-graph request for a measured delta: every re-read and deleted file, warm or not. */
function treeGraphRequestOf(tree: WorkingTree, measured: WorkingTreeMeasuredDelta): WorkingTreeGraphRequest {
  return {
    tree,
    changed: measured.reread,
    deleted: measured.deleted,
    fingerprint: treeGraphFingerprint(measured.delta.fingerprint, measured.reread, measured.deleted),
  };
}

type DirtyAtIndexTime = { kind: "listed"; paths: readonly string[] } | { kind: "unknown"; reason: string };

/**
 * The files the index holds with content its `indexedCommit` does not — dirty
 * when the run read the tree (live P1-1). A dirty stamp without the list is
 * UNKNOWN, not clean: it was written before the list existed, or git could not
 * answer, or a legacy run capped the list (`indexedDirtyPathsOverflowed`);
 * measuring past it would answer from content no commit holds while claiming
 * the tree matches.
 */
function dirtyAtIndexTime(git: RegistryGitState | undefined): DirtyAtIndexTime {
  if (git?.indexedDirtyPathsOverflowed) {
    return { kind: "unknown", reason: "index built from a dirty tree whose dirty files were not listed" };
  }
  if (git?.indexedDirtyPaths !== undefined) return { kind: "listed", paths: git.indexedDirtyPaths };
  if (git?.indexedDirty) {
    return { kind: "unknown", reason: "index built from a dirty tree; its dirty files are unknown" };
  }
  return { kind: "listed", paths: [] };
}

/**
 * The delta plus every file dirty at index time: the index holds that file's
 * index-time content, which a diff against `indexedCommit` cannot see once the
 * tree matches the commit again. Present in the tree → changed (re-read, even
 * when it still equals what was indexed); absent → deleted.
 */
async function foldDirtyAtIndexTime(
  root: string,
  delta: WorkingTreeDelta,
  dirtyPaths: readonly string[],
  accepts: (relativePath: string) => boolean,
): Promise<{ changed: string[]; deleted: string[] }> {
  const changed = new Set(delta.changed);
  const deleted = new Set(delta.deleted);
  const extra = dirtyPaths.filter((path) => !changed.has(path) && !deleted.has(path) && accepts(path));
  const present = await Promise.all(
    extra.map(async (path) =>
      fs.access(join(root, path)).then(
        () => true,
        () => false,
      ),
    ),
  );
  extra.forEach((path, i) => (present[i] ? changed : deleted).add(path));
  return { changed: [...changed].sort(), deleted: [...deleted].sort() };
}

/**
 * The delta's tree-graph key. The delta reader's fingerprint covers what git
 * status lists; the files folded in from the index-time dirty stamp are not
 * listed there, and they are part of what the graph is built over.
 */
function treeGraphFingerprint(
  deltaFingerprint: string,
  changed: readonly string[],
  deleted: readonly string[],
): string {
  return createHash("sha1")
    .update(deltaFingerprint)
    .update("\0")
    .update(changed.join("\n"))
    .update("\0")
    .update(deleted.join("\n"))
    .digest("hex");
}

/**
 * Start the tree graph's build now (warm-up: `graphFor(request, 0)`, result
 * ignored — the cache single-flights, the next read joins it) and return the
 * view's reader. A `built` answer is kept for the view's lifetime: the
 * published graph of one fingerprint never changes, so a second wait would
 * only re-ask the cache for the same file.
 */
function treeGraphReader(source: WorkingTreeGraphSource, request: WorkingTreeGraphRequest): WorkingTreeGraphReader {
  const ask = async (waitMs: number): Promise<WorkingTreeGraphState> =>
    source.graphFor(request, waitMs).catch((error: unknown) => ({
      kind: "unavailable" as const,
      reason: `tree graph source failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  void ask(0);
  let built: WorkingTreeGraphState | undefined;
  return async (waitMs) => {
    if (built) return built;
    const state = await ask(waitMs);
    if (state.kind === "built") built = state;
    return state;
  };
}

/**
 * The view's `signalDeltaRows`: each FILE of the delta is enriched at most once
 * per view, in one batch per call over the files that call newly names, so
 * concurrent calls naming the same file share its batch. A row is matched to a
 * delta row by id and path; the trajectory blocks of the enriched copy are
 * merged over the caller's payload, which may have been reshaped (an answered
 * pack member, a metaOnly hit) since it left the view. The delta row itself
 * comes back as the enriched row, one object per id for the view's lifetime.
 */
function deltaRowSignaller(
  source: WorkingTreeDeltaSignalSource,
  tree: WorkingTree,
  view: WorkingTreeView,
  renamedFrom: ReadonlyMap<string, string> | undefined,
): NonNullable<WorkingTreeView["signalDeltaRows"]> {
  const byFile = new Map<string, Promise<ReadonlyMap<string, ScrollChunk>>>();
  let deltaById: ReadonlyMap<string, ScrollChunk> | undefined;

  return async <R extends WorkingTreeSignalledRow>(rows: readonly R[]): Promise<R[]> => {
    if (rows.length === 0 || !view.readDeltaChunks) return [...rows];
    const deltaRows = await view.readDeltaChunks();
    const byId = (deltaById ??= new Map(deltaRows.map((row) => [String(row.id), row])));
    const deltaRowOf = (row: R): ScrollChunk | undefined => {
      if (row.id === undefined) return undefined;
      const delta = byId.get(String(row.id));
      const path = row.payload?.relativePath;
      return delta && (path === undefined || path === delta.payload.relativePath) ? delta : undefined;
    };

    const paths = new Set<string>();
    for (const row of rows) {
      const delta = deltaRowOf(row);
      if (delta) paths.add(relativePathOf(delta.payload));
    }
    if (paths.size === 0) return [...rows];
    const missing = [...paths].filter((path) => !byFile.has(path));
    if (missing.length > 0) {
      const wanted = new Set(missing);
      const batch = enrichDeltaRows(
        source,
        tree,
        deltaRows.filter((row) => wanted.has(relativePathOf(row.payload))),
        view,
        renamedFrom,
      ).then((enriched) => new Map(enriched.map((row) => [String(row.id), row])));
      for (const path of missing) byFile.set(path, batch);
    }
    const enrichedById = new Map<string, ScrollChunk>();
    for (const batch of await Promise.all([...paths].map(async (path) => byFile.get(path)))) {
      for (const [id, row] of batch ?? []) enrichedById.set(id, row);
    }

    return rows.map((row) => {
      const delta = deltaRowOf(row);
      const enriched = delta ? enrichedById.get(String(row.id)) : undefined;
      if (!enriched || !row.payload || row.payload === enriched.payload) return row;
      const payload = row.payload === delta?.payload ? enriched.payload : { ...row.payload };
      if (payload !== enriched.payload) {
        for (const key of WORKING_TREE_SIGNAL_PAYLOAD_KEYS) {
          if (enriched.payload[key] !== undefined) payload[key] = enriched.payload[key];
        }
      }
      return { ...row, payload };
    });
  };
}

/** Delta rows with their trajectory payload; the view keeps which graph the codegraph block came from. */
async function enrichDeltaRows(
  source: WorkingTreeDeltaSignalSource,
  tree: WorkingTree,
  rows: readonly ScrollChunk[],
  view: WorkingTreeView,
  renamedFrom: ReadonlyMap<string, string> | undefined,
): Promise<readonly ScrollChunk[]> {
  if (rows.length === 0) return rows;
  const { indexedCommit } = view.marker;
  const enriched = await source.enrich({
    tree,
    rows,
    ...(indexedCommit ? { indexedCommit } : {}),
    ...(renamedFrom && renamedFrom.size > 0 ? { renamedFrom } : {}),
    ...(view.readTreeGraph ? { readTreeGraph: view.readTreeGraph } : {}),
    ...(view.readTouchedBasePoints ? { readTouchedBasePoints: view.readTouchedBasePoints } : {}),
  });
  if (enriched.treeGraph) view.deltaRowsTreeGraph = enriched.treeGraph;
  return enriched.rows;
}

/** The changed files' rows; names the files that yielded none in `marker.unparsed`. */
async function readDeltaChunks(
  source: WorkingTreeDeltaChunkSource,
  tree: WorkingTree,
  changed: readonly string[],
  marker: WorkingTreeMarker,
): Promise<WorkingTreeChunkLayerRead> {
  if (changed.length === 0) return { chunks: [], unparsed: [] };
  const config = await source.resolveChunkerConfig(tree);
  const read = await source.layer.chunk(tree.root, changed, config, tree.baseIndex.collectionName);
  if (read.unparsed.length > 0) marker.unparsed = [...read.unparsed];
  return read;
}

/**
 * Start the delta rows' vectors now (WTO-5 warm-up: the rows are chunked, then
 * every vector is resolved in the background) and return the view's reader. A
 * chunk read that fails answers no vectors with its reason — the reader never
 * rejects, so the answer is made without the dense leg.
 */
function warmDeltaVectors(
  source: Pick<WorkingTreeDenseVectorSource, "warm">,
  collectionName: string,
  view: WorkingTreeView,
  readChunked: () => Promise<WorkingTreeChunkLayerRead>,
): WorkingTreeDenseVectorReader {
  const warmed: Promise<WorkingTreeDenseVectorReader> = readChunked().then(
    (read) =>
      source.warm({
        collectionName,
        rows: read.chunks,
        ...(read.storeKeys ? { storeKeys: read.storeKeys } : {}),
        ...(view.readTouchedBasePoints ? { readTouchedBasePoints: view.readTouchedBasePoints } : {}),
      }),
    (error: unknown) => {
      const failure = error instanceof Error ? error.message : String(error);
      return async () => ({ vectors: new Map(), pending: 0, failure });
    },
  );
  return async (waitMs) => (await warmed)(waitMs);
}
