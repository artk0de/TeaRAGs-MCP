/**
 * WorkingTreeOverlay (bd tea-rags-mcp-xi2r9.1) — the per-request view of the
 * tree a read answers for: its {@link WorkingTreeDelta} against the commit the
 * base index was built at, and the {@link WorkingTreeMarker} the answer carries.
 *
 * The marker is never omitted and `view` never throws: a tree that cannot be
 * measured — no commit stamp, an unknown commit, a delta over the cap, a git
 * failure — still yields a marker, with `degraded` saying why and what fixes
 * it. A degraded view touches no path, so nothing is substituted or hidden.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { CollectionEntry, RegistryGitState } from "../../../contracts/types/registry.js";
import {
  WORKING_TREE_DELTA_FILE_CAP,
  type WorkingTree,
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
import {
  WORKING_TREE_REINDEX_REMEDY,
  WORKING_TREE_WORKTREE_INDEX_REMEDY,
  type WorkingTreeDelta,
  type WorkingTreeDeltaReader,
} from "./delta.js";
import type { WorkingTreeDenseVectorReader, WorkingTreeDenseVectorSource } from "./dense-floor.js";
import { relativePathOf } from "./substitute.js";

export interface WorkingTreeView {
  marker: WorkingTreeMarker;
  /** changed ∪ deleted; empty when degraded (nothing substituted, nothing hidden) */
  touchedPaths: ReadonlySet<string>;
  deletedPaths: ReadonlySet<string>;
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
   * The base-index points of the touched files (bd tea-rags-mcp-xi2r9): read
   * once per view and shared by every consumer — hybrid's `has_id` exclusion
   * and the delta signals' inheritance. Present only on a measured non-empty
   * delta with a base-point reader wired.
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
  pointsOf: (
    collectionName: string,
    touchedPaths: ReadonlySet<string>,
    indexedCommit: string | null,
  ) => Promise<WorkingTreeTouchedBasePointsByPath>;
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
}

const NO_TREE_REASON = "no working tree resolved for this index";
const NO_TREE_REMEDY = "pass path=<your working directory>";
const UNREADABLE_REMEDY = "check that {tree} is a readable git checkout";

const EMPTY_PATHS: ReadonlySet<string> = new Set();

export class WorkingTreeOverlay {
  constructor(private readonly deps: WorkingTreeOverlayDeps) {}

  /** Never throws for git trouble: a failure becomes `marker.degraded`. */
  async view(tree: WorkingTree, alias: string | undefined): Promise<WorkingTreeView> {
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
    // `measured` → the delta WAS measured and only refused (the cap): its counts
    // are reported (live D11a), since `0` must mean measured-and-empty.
    const degraded = (
      reason: string,
      remedy: string,
      measured?: { changedFiles: number; deletedFiles: number },
    ): WorkingTreeView => ({
      marker: { ...marker, ...measured, degraded: { reason, remedy: fill(remedy) } },
      touchedPaths: EMPTY_PATHS,
      deletedPaths: EMPTY_PATHS,
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
      const total = changed.length + deleted.length;
      if (total > WORKING_TREE_DELTA_FILE_CAP) {
        return degraded(
          `delta of ${total} files over the ${WORKING_TREE_DELTA_FILE_CAP}-file cap`,
          WORKING_TREE_WORKTREE_INDEX_REMEDY,
          { changedFiles: changed.length, deletedFiles: deleted.length },
        );
      }
      const view: WorkingTreeView = {
        marker: { ...marker, changedFiles: changed.length, deletedFiles: deleted.length },
        touchedPaths: new Set([...changed, ...deleted]),
        deletedPaths: new Set(deleted),
        ...(read.delta.renamedFrom && read.delta.renamedFrom.size > 0 ? { renamedFrom: read.delta.renamedFrom } : {}),
      };
      if (total > 0 && this.deps.treeGraph) {
        const request: WorkingTreeGraphRequest = {
          tree,
          changed,
          deleted,
          fingerprint: treeGraphFingerprint(read.delta.fingerprint, changed, deleted),
        };
        view.readTreeGraph = treeGraphReader(this.deps.treeGraph, request);
      }
      const { touchedBasePoints } = this.deps;
      if (total > 0 && touchedBasePoints) {
        let points: Promise<WorkingTreeTouchedBasePointsByPath> | undefined;
        view.readTouchedBasePoints = async () =>
          (points ??= touchedBasePoints.pointsOf(collectionName, view.touchedPaths, indexedCommit));
      }
      const source = this.deps.deltaChunks;
      if (source) {
        const { deltaSignals, denseVectors } = this.deps;
        let chunked: Promise<WorkingTreeChunkLayerRead> | undefined;
        const readChunked = async (): Promise<WorkingTreeChunkLayerRead> =>
          (chunked ??= readDeltaChunks(source, tree, changed, view.marker));
        view.readDeltaChunks = async () => (await readChunked()).chunks;
        if (deltaSignals) {
          view.signalDeltaRows = deltaRowSignaller(deltaSignals, tree, view, read.delta.renamedFrom);
        }
        if (denseVectors && changed.length > 0) {
          view.readDeltaVectors = warmDeltaVectors(denseVectors, collectionName, view, readChunked);
        }
      }
      return view;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return degraded(`cannot read the working tree delta: ${message.split("\n")[0]}`, UNREADABLE_REMEDY);
    }
  }
}

type DirtyAtIndexTime = { kind: "listed"; paths: readonly string[] } | { kind: "unknown"; reason: string };

/**
 * The files the index holds with content its `indexedCommit` does not — dirty
 * when the run read the tree (live P1-1). A dirty stamp without the list is
 * UNKNOWN, not clean: it was written before the list existed, or git could not
 * answer, or the list overflowed; measuring past it would answer from content
 * no commit holds while claiming the tree matches.
 */
function dirtyAtIndexTime(git: RegistryGitState | undefined): DirtyAtIndexTime {
  if (git?.indexedDirtyPathsOverflowed) {
    return { kind: "unknown", reason: `index built from a tree with over ${WORKING_TREE_DELTA_FILE_CAP} dirty files` };
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
