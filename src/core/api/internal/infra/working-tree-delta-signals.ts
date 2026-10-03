/**
 * Trajectory payload for working-tree delta rows (bd tea-rags-mcp-xi2r9,
 * WTO-6/7) — the `WorkingTreeDeltaSignalSource` the overlay applies once, inside
 * `readDeltaChunks`, so every search tool ranks the tree's rows with the signals
 * their indexed twins carry. The chunk layer yields structure only; without
 * this a modified file's rows rank as code with no history and no graph (live
 * probe: `hybrid.ts` at #24, 0.132, under `hotspots`).
 *
 * Lives in `api/internal` because it bridges what explore may not see: the
 * tree graph (`adapters/duckdb`) and the codegraph signal arithmetic
 * (`domains/trajectory/codegraph`). The base collection's payload it does NOT
 * read itself: the request carries the view's touched-base-point read
 * (`readTouchedBasePoints`), the one read hybrid's exclusion shares.
 *
 * - **git** — `git.file` is inherited from the base points of the file's
 *   HISTORY path: an uncommitted edit has no history of its own, the file's
 *   history is the base's. The history path is the file's own, or for a file
 *   moved in the tree (`renamedFrom`) its OLD path (D12). `git.chunk` comes
 *   from the base point of the same symbol — the exact id first, else the
 *   symbol's family (`#partN` stripped) or its first part. What no base point
 *   answers the git trajectory computes on demand (`gitSignals`, D12):
 *   `git.file` of a history path the base never chunked (below the chunk
 *   floor, committed after the index), `git.chunk` of a row whose symbol the
 *   base never held — attributed over the row's TREE lines, where lines the
 *   working file added hold no history. A brand-new symbol is all such lines:
 *   it gets no chunk block, and the reranker's alpha blend falls back to the
 *   file value (by design, not a gap). An untracked file never committed has
 *   no history: no `git.file`, and each row the chunk walk's zero block — what
 *   ingest writes for it in the alias's own checkout (live round-3 D4).
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
  WorkingTreeGitSignals,
  WorkingTreeGitSignalSource,
  WorkingTreeGitSignalTarget,
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

/** Tree-graph signal reads kept per process — one per recent (graph, file set). */
const TREE_SIGNAL_CACHE_SIZE = 4;

const SPLIT_PART_SUFFIX = /#part\d+$/;
const ZERO_FILE_METRICS: FileGraphMetrics = { fanIn: 0, fanOut: 0, transitiveImpact: 0 };

type PayloadBlock = Record<string, unknown>;

export interface WorkingTreeDeltaSignalSourceDeps {
  /**
   * Opens the tree graph's file. Late-bound: the overlay that owns this source
   * is composed before the codegraph pool exists. `undefined` → codegraph off,
   * and a `built` state (which then cannot happen) inherits.
   */
  graphFiles: () => WorkingTreeGraphFileOpener | undefined;
  /**
   * The git trajectory's on-demand `git.file` / `git.chunk`, for what no base
   * point (of the history path) answers. Absent → such rows keep only what
   * they inherit.
   */
  gitSignals?: WorkingTreeGitSignalSource;
}

/** The touched files' base payload by path, and whether the base index carries git at all. */
interface BasePayload {
  byFile: Map<string, BaseFilePayload>;
  /**
   * `false` only on evidence: base points were read and none carries
   * `git.file` — an index built with git off, whose delta rows must not grow a
   * git block the rest of the collection lacks.
   */
  carriesGit: boolean;
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
      const historyPathOf = (path: string): string => request.renamedFrom?.get(path) ?? path;
      const base = await groupBasePayload(request, [...new Set(paths.map(historyPathOf))]);

      const readTree = async (): Promise<{ treeGraph?: WorkingTreeGraphState; tree?: TreeGraphSignals }> => {
        if (!request.readTreeGraph) return {};
        const treeGraph = await request.readTreeGraph(WORKING_TREE_SEARCH_GRAPH_WAIT_MS);
        const opener = deps.graphFiles();
        if (treeGraph.kind !== "built") return { treeGraph };
        if (!opener) return { treeGraph: { kind: "unavailable", reason: "codegraph is disabled" } };
        try {
          return { treeGraph, tree: await readTreeSignals(opener, treeGraph.dbPath, paths) };
        } catch (error) {
          return { treeGraph: { kind: "unavailable", reason: `tree graph unreadable: ${messageOf(error)}` } };
        }
      };
      const [{ treeGraph, tree }, onDemandGit] = await Promise.all([
        readTree(),
        readOnDemandGit(deps.gitSignals, request, base, historyPathOf),
      ]);

      const rows = request.rows.map((row) =>
        enrichRow(row, base.byFile, tree, historyPathOf(pathOf(row.payload)), onDemandGit),
      );
      return treeGraph ? { rows, treeGraph } : { rows };
    },
  };
}

/**
 * The delta files' base payload, from the view's touched-base-point read — the
 * one hybrid's exclusion shares, read per path and cached per index revision
 * (bd tea-rags-mcp-xi2r9: a multi-path `relativePath` scroll here cost 4.5 s on
 * every request at 137 delta files). `paths` are HISTORY paths: a renamed
 * file's old path, which the touched set holds as deleted. No reader → nothing
 * to inherit.
 */
async function groupBasePayload(
  request: WorkingTreeDeltaSignalRequest,
  paths: readonly string[],
): Promise<BasePayload> {
  const byFile = new Map<string, BaseFilePayload>();
  if (!request.readTouchedBasePoints) return { byFile, carriesGit: true };
  const touched = await request.readTouchedBasePoints();
  for (const path of paths) {
    for (const { payload } of touched.get(path) ?? []) {
      if (pathOf(payload) !== path) continue;
      let file = byFile.get(path);
      if (!file) {
        file = { bySymbol: new Map() };
        byFile.set(path, file);
      }
      addBasePoint(file, payload);
    }
  }
  let sawPoint = false;
  for (const points of touched.values()) {
    for (const { payload } of points) {
      if (blockAt(payload, ["git", "file"])) return { byFile, carriesGit: true };
      sawPoint = true;
    }
  }
  return { byFile, carriesGit: !sawPoint };
}

/**
 * Git signals computed on demand for what no base point answers (D12):
 * `git.file` of a history path the base never chunked (below the chunk floor,
 * committed after the index, a move whose old path it never chunked), and
 * `git.chunk` of a row no base point of the same symbol answers — inheritance
 * stays wherever one does. Asked once per request, in the rows' TREE lines;
 * an index without git asks nothing. A failure answers nothing.
 */
async function readOnDemandGit(
  source: WorkingTreeGitSignalSource | undefined,
  request: WorkingTreeDeltaSignalRequest,
  base: BasePayload,
  historyPathOf: (path: string) => string,
): Promise<ReadonlyMap<string, WorkingTreeGitSignals>> {
  if (!source || !base.carriesGit) return new Map();
  const targets = new Map<
    string,
    WorkingTreeGitSignalTarget & { chunks: WorkingTreeGitSignalTarget["chunks"][number][] }
  >();
  for (const { id, payload } of request.rows) {
    const path = pathOf(payload);
    if (path === "") continue;
    const historyPath = historyPathOf(path);
    const historyFile = base.byFile.get(historyPath);
    const wantFile = !historyFile?.gitFile;
    const { startLine, endLine } = payload;
    const hasLines = typeof startLine === "number" && typeof endLine === "number";
    const wantChunk = hasLines && !(historyFile && basePointOf(historyFile, payload.symbolId));
    if (!wantFile && !wantChunk) continue;
    let target = targets.get(historyPath);
    if (!target) {
      target = { relativePath: historyPath, treePath: path, maxEndLine: 0, fileSignals: wantFile, chunks: [] };
      targets.set(historyPath, target);
    }
    if (hasLines) {
      target.maxEndLine = Math.max(target.maxEndLine, endLine);
      if (wantChunk) target.chunks.push({ key: String(id), startLine, endLine });
    }
  }
  if (targets.size === 0) return new Map();
  return source.signalsOf(request.tree.root, [...targets.values()]).catch(() => new Map());
}

/** Folds one base point into its file: the first file blocks seen, the first point per symbolId. */
function addBasePoint(file: BaseFilePayload, payload: Record<string, unknown>): void {
  file.gitFile ??= blockAt(payload, ["git", "file"]);
  file.codegraphFile ??= blockAt(payload, ["codegraph", "symbols", "file"]);
  const { symbolId } = payload;
  if (typeof symbolId === "string" && symbolId !== "" && !file.bySymbol.has(symbolId)) {
    file.bySymbol.set(symbolId, payload);
  }
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
  historyPath: string,
  onDemandGit: ReadonlyMap<string, WorkingTreeGitSignals>,
): WorkingTreeDeltaRow {
  const path = pathOf(row.payload);
  const file = base.get(path);
  const basePoint = file ? basePointOf(file, row.payload.symbolId) : undefined;
  const payload: Record<string, unknown> = { ...row.payload };

  // git follows the file's HISTORY path — its own, or the old path of a move.
  // A base point answers first; what none answers was computed on demand.
  const historyFile = base.get(historyPath);
  const onDemand = onDemandGit.get(historyPath);
  // A path no commit touched has no file block, only the walk's zero chunk
  // blocks — what ingest writes for an untracked file (live round-3 D4).
  const gitFile = historyFile?.gitFile ?? onDemand?.file;
  const historyPoint = historyFile?.gitFile ? basePointOf(historyFile, row.payload.symbolId) : undefined;
  const gitChunk = historyPoint ? blockAt(historyPoint, ["git", "chunk"]) : onDemand?.chunks.get(String(row.id));
  if (gitFile || gitChunk) {
    payload.git = { ...(gitFile ? { file: gitFile } : {}), ...(gitChunk ? { chunk: gitChunk } : {}) };
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
