/**
 * Trajectory payload for working-tree delta rows (bd tea-rags-mcp-xi2r9,
 * WTO-6/7) — the `WorkingTreeDeltaSignalSource` the overlay applies once, inside
 * `readDeltaChunks`, so every search tool ranks the tree's rows with the signals
 * their indexed twins carry. The chunk layer yields structure only; without
 * this a modified file's rows rank as code with no history and no graph (live
 * probe: `hybrid.ts` at #24, 0.132, under `hotspots`).
 *
 * Lives in `api/internal` because it bridges what explore may not see: the
 * base collection's payload (Qdrant), the tree graph (`adapters/duckdb`), and
 * the codegraph signal arithmetic (`domains/trajectory/codegraph`).
 *
 * - **git** — `git.file` is inherited from the base points of the same file:
 *   an uncommitted edit has no history of its own, the file's history is the
 *   base's. `git.chunk` comes from the base point of the same symbol — the
 *   exact id first, else the symbol's family (`#partN` stripped) or its first
 *   part — and is absent for a symbol the base never had, where the reranker's
 *   alpha blend falls back to the file value. A file the base never had (new,
 *   untracked) has no base point and gets no git block.
 * - **codegraph** — the tree graph, when `readTreeGraph` answers `built` within
 *   {@link WORKING_TREE_SEARCH_GRAPH_WAIT_MS}: file signals by
 *   `buildCodegraphFileSignals` over the tree's file metrics and fan-in p95,
 *   chunk signals by the ONE settlement every producer runs
 *   (`settleCodegraphChunkSignals`, `persisted` ranges from the tree's
 *   `cg_symbols`) — the payload heal's computation, against another file.
 *   A file the tree graph holds no row for (a doc, an excluded path), or no tree
 *   graph at all, inherits `codegraph.symbols.{file,chunk}` from the base points
 *   like git, and the result carries the state that decided it.
 * - Keys are PHYSICAL (`codegraph.symbols.file.*`): the payload stores the
 *   provider key, and a logical `codegraph.file.*` would be a key no reader
 *   resolves (`domains/trajectory/codegraph/CLAUDE.md`).
 */

import { anyOfOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import type {
  ChunkGraphSignals,
  FileGraphMetrics,
  FileScopedSymbolId,
  PersistedSymbolLineRanges,
} from "../../../contracts/types/codegraph.js";
import type { ChunkSignalOverlay } from "../../../contracts/types/provider.js";
import type {
  WorkingTreeDeltaRow,
  WorkingTreeDeltaSignalRequest,
  WorkingTreeDeltaSignalResult,
  WorkingTreeDeltaSignalSource,
  WorkingTreeGraphState,
} from "../../../contracts/types/working-tree.js";
import {
  settleCodegraphChunkSignals,
  type CodegraphStoredChunk,
} from "../../../domains/trajectory/codegraph/symbols/chunk-signal-settlement.js";
import { buildCodegraphFileSignals } from "../../../domains/trajectory/codegraph/symbols/payload-signals.js";
import type { WorkingTreeGraphFileOpener } from "./working-tree-graph-read.js";

/** How long a search waits for the tree graph before delta rows inherit the base's codegraph (spec: 3 s). */
export const WORKING_TREE_SEARCH_GRAPH_WAIT_MS = 3_000;

/** Base points read per delta: 200 files at most, so this bounds a pathological file, not a normal delta. */
const BASE_POINT_SCROLL_LIMIT = 50_000;
const BASE_POINT_PAYLOAD = ["relativePath", "symbolId", "git", "codegraph"];
/** Tree-graph signal reads kept per process — one per recent (graph, file set). */
const TREE_SIGNAL_CACHE_SIZE = 4;

const SPLIT_PART_SUFFIX = /#part\d+$/;
const ZERO_FILE_METRICS: FileGraphMetrics = { fanIn: 0, fanOut: 0, transitiveImpact: 0 };

type PayloadBlock = Record<string, unknown>;

export interface WorkingTreeDeltaSignalSourceDeps {
  qdrant: {
    scrollFiltered: (
      collectionName: string,
      filter: Record<string, unknown>,
      limit: number,
      pageSize?: number,
      payloadInclude?: string[],
    ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
  };
  /**
   * Opens the tree graph's file. Late-bound: the overlay that owns this source
   * is composed before the codegraph pool exists. `undefined` → codegraph off,
   * and a `built` state (which then cannot happen) inherits.
   */
  graphFiles: () => WorkingTreeGraphFileOpener | undefined;
}

/** The base payload of one file: its file blocks and its points by symbolId. */
interface BaseFilePayload {
  gitFile?: PayloadBlock;
  codegraphFile?: PayloadBlock;
  bySymbol: Map<string, Record<string, unknown>>;
}

/** What the tree graph says about the delta's files. */
interface TreeGraphSignals {
  fileSignals: Map<string, PayloadBlock>;
  chunkSignals: Map<FileScopedSymbolId, ChunkGraphSignals>;
  ranges: Map<string, PersistedSymbolLineRanges>;
}

export function createWorkingTreeDeltaSignalSource(
  deps: WorkingTreeDeltaSignalSourceDeps,
): WorkingTreeDeltaSignalSource {
  const treeSignalCache = new Map<string, Promise<TreeGraphSignals>>();

  /** Rejects when the graph cannot be read; `enrich` turns that into an inherited answer. */
  const readTreeSignals = async (
    opener: WorkingTreeGraphFileOpener,
    dbPath: string,
    paths: readonly string[],
  ): Promise<TreeGraphSignals> => {
    const key = `${dbPath}\0${paths.join("\0")}`;
    let read = treeSignalCache.get(key);
    if (!read) {
      read = loadTreeSignals(opener, dbPath, paths);
      treeSignalCache.set(key, read);
      read.catch(() => treeSignalCache.delete(key));
      while (treeSignalCache.size > TREE_SIGNAL_CACHE_SIZE) {
        treeSignalCache.delete(treeSignalCache.keys().next().value as string);
      }
    }
    return read;
  };

  return {
    enrich: async (request: WorkingTreeDeltaSignalRequest): Promise<WorkingTreeDeltaSignalResult> => {
      const paths = [...new Set(request.rows.map((row) => pathOf(row.payload)).filter((p) => p !== ""))].sort();
      if (paths.length === 0) return { rows: [...request.rows] };
      const base = await readBasePayload(deps, request.tree.baseIndex.collectionName, paths);

      let treeGraph: WorkingTreeGraphState | undefined;
      let tree: TreeGraphSignals | undefined;
      if (request.readTreeGraph) {
        treeGraph = await request.readTreeGraph(WORKING_TREE_SEARCH_GRAPH_WAIT_MS);
        const opener = deps.graphFiles();
        if (treeGraph.kind === "built" && !opener) treeGraph = { kind: "unavailable", reason: "codegraph is disabled" };
        if (treeGraph.kind === "built" && opener) {
          try {
            tree = await readTreeSignals(opener, treeGraph.dbPath, paths);
          } catch (error) {
            treeGraph = { kind: "unavailable", reason: `tree graph unreadable: ${messageOf(error)}` };
          }
        }
      }

      const rows = request.rows.map((row) => enrichRow(row, base, tree));
      return treeGraph ? { rows, treeGraph } : { rows };
    },
  };
}

/** One scroll for the base points of every delta file, grouped by file. */
async function readBasePayload(
  deps: WorkingTreeDeltaSignalSourceDeps,
  collectionName: string,
  paths: readonly string[],
): Promise<Map<string, BaseFilePayload>> {
  const points = await deps.qdrant.scrollFiltered(
    collectionName,
    { must: [anyOfOnTextIndexed("relativePath", paths)] },
    BASE_POINT_SCROLL_LIMIT,
    undefined,
    BASE_POINT_PAYLOAD,
  );
  const wanted = new Set(paths);
  const byFile = new Map<string, BaseFilePayload>();
  for (const { payload } of points) {
    const path = pathOf(payload);
    if (!wanted.has(path)) continue;
    let file = byFile.get(path);
    if (!file) {
      file = { bySymbol: new Map() };
      byFile.set(path, file);
    }
    file.gitFile ??= blockAt(payload, ["git", "file"]);
    file.codegraphFile ??= blockAt(payload, ["codegraph", "symbols", "file"]);
    const { symbolId } = payload;
    if (typeof symbolId === "string" && symbolId !== "" && !file.bySymbol.has(symbolId)) {
      file.bySymbol.set(symbolId, payload);
    }
  }
  return byFile;
}

/**
 * The tree graph's signals for the delta's files: file metrics and fan-in p95
 * (over the FULL file universe, as every producer reads it), the whole graph's
 * chunk signals (there is no per-symbol bulk form), and the files' persisted
 * symbol ranges for the settlement.
 */
async function loadTreeSignals(
  opener: WorkingTreeGraphFileOpener,
  dbPath: string,
  paths: readonly string[],
): Promise<TreeGraphSignals> {
  const { graphDb } = await opener.acquireFileReader(dbPath);
  try {
    const fanInP95 = await graphDb.getFanInP95();
    const metrics = await graphDb.getFileMetricsBulk(paths);
    const ranges = await graphDb.getSymbolLineRangesBulk(paths);
    const chunkSignals = await graphDb.getChunkSignalsBulk();
    const fileSignals = new Map<string, PayloadBlock>();
    for (const path of paths) {
      // A file the graph holds neither edges nor symbols for is one it never
      // walked (a doc, an excluded path): it inherits, it is not "zero".
      if (!metrics.has(path) && !ranges.has(path)) continue;
      fileSignals.set(path, { ...buildCodegraphFileSignals(metrics.get(path) ?? ZERO_FILE_METRICS, fanInP95) });
    }
    return { fileSignals, chunkSignals, ranges };
  } finally {
    await graphDb.close().catch(() => undefined);
  }
}

function enrichRow(
  row: WorkingTreeDeltaRow,
  base: ReadonlyMap<string, BaseFilePayload>,
  tree: TreeGraphSignals | undefined,
): WorkingTreeDeltaRow {
  const path = pathOf(row.payload);
  const file = base.get(path);
  const basePoint = file ? basePointOf(file, row.payload.symbolId) : undefined;
  const payload: Record<string, unknown> = { ...row.payload };

  if (file?.gitFile) {
    const gitChunk = basePoint ? blockAt(basePoint, ["git", "chunk"]) : undefined;
    payload.git = { file: file.gitFile, ...(gitChunk ? { chunk: gitChunk } : {}) };
  }

  const treeFile = tree?.fileSignals.get(path);
  if (tree && treeFile) {
    const chunk = settledTreeChunk(path, row.payload, tree);
    payload.codegraph = {
      symbols: { file: { ...file?.codegraphFile, ...treeFile }, ...(chunk ? { chunk } : {}) },
    };
  } else if (file?.codegraphFile) {
    const cgChunk = basePoint ? blockAt(basePoint, ["codegraph", "symbols", "chunk"]) : undefined;
    payload.codegraph = { symbols: { file: file.codegraphFile, ...(cgChunk ? { chunk: cgChunk } : {}) } };
  }
  return { id: row.id, payload };
}

/**
 * The row's chunk signals by the ONE settlement (bd tea-rags-mcp-39xca.2):
 * anchored on its symbolId, placed against the tree's persisted ranges. An
 * unowned or unsettled chunk gets no chunk block — never the anchor's numbers.
 */
function settledTreeChunk(
  path: string,
  payload: Record<string, unknown>,
  tree: TreeGraphSignals,
): ChunkSignalOverlay | undefined {
  const { startLine, endLine, symbolId } = payload;
  if (typeof startLine !== "number" || typeof endLine !== "number") return undefined;
  const persisted = tree.ranges.get(path);
  const stored: CodegraphStoredChunk = {
    chunkId: "delta",
    startLine,
    endLine,
    ...(typeof symbolId === "string" && symbolId !== "" ? { symbolId } : {}),
  };
  const settlement = settleCodegraphChunkSignals(
    path,
    { kind: "persisted", ranges: persisted?.ranges ?? [], rowsWithoutRanges: persisted?.rowsWithoutRanges ?? 0 },
    [stored],
    tree.chunkSignals,
  );
  if (settlement.kind !== "signals") return undefined;
  const settled = settlement.chunks.get(stored.chunkId);
  return settled?.kind === "owned" ? settled.signals : undefined;
}

/** The base point answering for `symbolId`: exact, else its family, else the family's first part. */
function basePointOf(file: BaseFilePayload, symbolId: unknown): Record<string, unknown> | undefined {
  if (typeof symbolId !== "string" || symbolId === "") return undefined;
  const family = symbolId.replace(SPLIT_PART_SUFFIX, "");
  return file.bySymbol.get(symbolId) ?? file.bySymbol.get(family) ?? file.bySymbol.get(`${family}#part1`);
}

function blockAt(payload: Record<string, unknown>, keys: readonly string[]): PayloadBlock | undefined {
  let node: unknown = payload;
  for (const key of keys) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "object" && node !== null && !Array.isArray(node) ? (node as PayloadBlock) : undefined;
}

function pathOf(payload: Record<string, unknown> | undefined): string {
  const path = payload?.relativePath;
  return typeof path === "string" ? path : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
