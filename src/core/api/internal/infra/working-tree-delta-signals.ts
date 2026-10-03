/**
 * Trajectory payload for working-tree delta rows (bd tea-rags-mcp-xi2r9,
 * WTO-6/7) — the `WorkingTreeDeltaSignalSource` the overlay applies through
 * `signalDeltaRows`, file by file as answers admit rows (live C1), so every
 * search tool ranks the tree's rows with the signals their indexed twins carry.
 * The chunk layer yields structure only; without this a modified file's rows
 * rank as code with no history and no graph (live probe: `hybrid.ts` at #24,
 * 0.132, under `hotspots`). A row's blocks do not depend on which other rows
 * share its batch: the graph-wide reads are kept per graph file, and a view's
 * tree-graph wait is made once for all its batches.
 *
 * Lives in `api/internal` because it bridges what explore may not see: the
 * tree graph (`adapters/duckdb`) and the codegraph signal arithmetic
 * (`domains/trajectory/codegraph`). The base collection's payload it does NOT
 * read itself: the request carries the view's touched-base-point reader
 * (`readTouchedBasePoints`), asked the full points of the signalled files only.
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
 *   it gets the chunk walk's zero block, as ingest writes it (live G4). An
 *   untracked file never committed has no history: no `git.file`, and each row
 *   the chunk walk's zero block — what ingest writes for it in the alias's own
 *   checkout (live round-3 D4).
 * - A file a COMMIT on either side of `indexedCommit...HEAD` touched (asked
 *   once per request) has a history at HEAD its base points do not describe —
 *   commits since the index (live G1 — a just-committed file ranked 196 days
 *   old), or index commits a tree branched from an older main lacks: nothing
 *   is inherited, its `git.file` and every row's `git.chunk` are computed from
 *   the tree's history. A committed move is computed at its new path, whose
 *   history follows the rename. A file changed only by uncommitted edits keeps
 *   inheriting.
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
import {
  WORKING_TREE_SEARCH_GRAPH_WAIT_MS,
  type WorkingTreeDeltaRow,
  type WorkingTreeDeltaSignalRequest,
  type WorkingTreeDeltaSignalResult,
  type WorkingTreeDeltaSignalSource,
  type WorkingTreeGitSignals,
  type WorkingTreeGitSignalSource,
  type WorkingTreeGitSignalTarget,
  type WorkingTreeGraphReader,
  type WorkingTreeGraphState,
  type WorkingTreeTouchedBasePointsByPath,
  type WorkingTreeTouchedBasePointsReader,
} from "../../../contracts/types/working-tree.js";
import { fileLinesOf } from "../../../domains/ingest/index.js";
import {
  settleCodegraphChunkSignals,
  type CodegraphStoredChunk,
} from "../../../domains/trajectory/codegraph/symbols/chunk-signal-settlement.js";
import { buildCodegraphFileSignals } from "../../../domains/trajectory/codegraph/symbols/payload-signals.js";
import { gitFileSignalsAtLineCount } from "../../../domains/trajectory/git/index.js";
import type { WorkingTreeGraphFileOpener } from "./working-tree-graph-read.js";

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
  const graphWideCache = new Map<string, Promise<GraphWideSignals>>();
  /**
   * The tree-graph state each view's rows were enriched with, by the view's
   * reader: the first batch waits for the graph, every later batch of the same
   * view reuses that answer — one wait per request, and one graph provenance
   * for all of a view's rows however many batches the answer admits.
   */
  const viewGraphStates = new WeakMap<WorkingTreeGraphReader, Promise<WorkingTreeGraphState>>();

  const graphStateOf = async (readTreeGraph: WorkingTreeGraphReader): Promise<WorkingTreeGraphState> => {
    let state = viewGraphStates.get(readTreeGraph);
    if (!state) {
      state = readTreeGraph(WORKING_TREE_SEARCH_GRAPH_WAIT_MS);
      viewGraphStates.set(readTreeGraph, state);
    }
    return state;
  };

  const graphWideOf =
    (dbPath: string) =>
    async (graphDb: TreeGraphDb): Promise<GraphWideSignals> => {
      let read = graphWideCache.get(dbPath);
      if (!read) {
        read = readGraphWideSignals(graphDb);
        graphWideCache.set(dbPath, read);
        read.catch(() => graphWideCache.delete(dbPath));
        while (graphWideCache.size > TREE_SIGNAL_CACHE_SIZE) {
          graphWideCache.delete(graphWideCache.keys().next().value as string);
        }
      }
      return read;
    };

  /** Rejects when the graph cannot be read; `enrich` turns that into an inherited answer. */
  const readTreeSignals = async (
    opener: WorkingTreeGraphFileOpener,
    dbPath: string,
    paths: readonly string[],
  ): Promise<TreeGraphSignals> => {
    const key = `${dbPath}\0${paths.join("\0")}`;
    let read = treeSignalCache.get(key);
    if (!read) {
      read = loadTreeSignals(opener, dbPath, paths, graphWideOf(dbPath));
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
      const inheritedPathOf = (path: string): string => request.renamedFrom?.get(path) ?? path;
      const [base, committedSince] = await Promise.all([
        groupBasePayload(request, [...new Set(paths.map(inheritedPathOf))]),
        readCommittedSince(deps.gitSignals, request),
      ]);
      const historyOf = (path: string): GitHistory => gitHistoryOf(path, inheritedPathOf(path), committedSince);

      const readTree = async (): Promise<{ treeGraph?: WorkingTreeGraphState; tree?: TreeGraphSignals }> => {
        if (!request.readTreeGraph) return {};
        const treeGraph = await graphStateOf(request.readTreeGraph);
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
        readOnDemandGit(deps.gitSignals, request, base, historyOf),
      ]);

      const lineCounts = treeLineCounts(request.rows);
      const rows = request.rows.map((row) =>
        enrichRow(row, base.byFile, tree, historyOf(pathOf(row.payload)), onDemandGit, lineCounts),
      );
      return treeGraph ? { rows, treeGraph } : { rows };
    },
  };
}

/**
 * The delta files' base payload, from the view's touched-base-point reader —
 * the FULL points (git, codegraph) of exactly `paths`, read per path and cached
 * per index revision (bd tea-rags-mcp-xi2r9: a multi-path `relativePath` scroll
 * here cost 4.5 s on every request at 137 delta files; reading every touched
 * file's heavy payload cost ~5 s at 3,198). `paths` are the signalled rows'
 * HISTORY paths: a renamed file's old path, which the touched set holds as
 * deleted. No reader → nothing to inherit.
 */
async function groupBasePayload(
  request: WorkingTreeDeltaSignalRequest,
  paths: readonly string[],
): Promise<BasePayload> {
  const byFile = new Map<string, BaseFilePayload>();
  const read = request.readTouchedBasePoints;
  if (!read) return { byFile, carriesGit: true };
  const touched = await read({ tier: "full", paths });
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
  return { byFile, carriesGit: await baseCarriesGit(read, touched) };
}

/**
 * Whether the base index carries git: `false` only on evidence — base points
 * read without a `git.file`. The signalled files' own points decide when one
 * carries it; otherwise (none carries it, or they have no points — a brand-new
 * file) ONE other touched file with base points is read full and decides, so
 * the answer never costs the whole delta's heavy payload. Which file: the
 * first, in path order, the light points show holding any.
 */
async function baseCarriesGit(
  read: WorkingTreeTouchedBasePointsReader,
  signalled: WorkingTreeTouchedBasePointsByPath,
): Promise<boolean> {
  const evidence = gitEvidenceOf(signalled);
  if (evidence === "carries") return true;
  const light = await read({ tier: "light" });
  const probe = [...light.keys()].find((path) => !signalled.has(path) && (light.get(path)?.length ?? 0) > 0);
  if (probe === undefined) return evidence === "unknown";
  return gitEvidenceOf(await read({ tier: "full", paths: [probe] })) !== "lacks";
}

/** What `points` say about git: one carries `git.file`, all lack it, or there are none. */
function gitEvidenceOf(points: WorkingTreeTouchedBasePointsByPath): "carries" | "lacks" | "unknown" {
  let sawPoint = false;
  for (const pathPoints of points.values()) {
    for (const { payload } of pathPoints) {
      if (blockAt(payload, ["git", "file"])) return "carries";
      sawPoint = true;
    }
  }
  return sawPoint ? "lacks" : "unknown";
}

/**
 * Where a delta file's git comes from. `path` is the history path — the file's
 * own, or for a move the old path its history sits at (D12). `moved` → a commit
 * since the index touched it: the base points predate that history, so the
 * file's git is recomputed and nothing is inherited (live G1).
 */
interface GitHistory {
  path: string;
  moved: boolean;
}

/**
 * A committed move's history follows it to the new path (the file signals walk
 * renames onto the HEAD path), so a tree path a commit touched is its own
 * history; otherwise the inherited path is, moved when a commit touched it.
 * Without the committed set nothing is known to have moved.
 */
function gitHistoryOf(
  treePath: string,
  inheritedPath: string,
  committedSince: ReadonlySet<string> | undefined,
): GitHistory {
  if (committedSince?.has(treePath)) return { path: treePath, moved: true };
  return { path: inheritedPath, moved: committedSince?.has(inheritedPath) ?? false };
}

/**
 * The paths a commit on either side of `indexedCommit...HEAD` touched — asked once per request
 * (a view enriches its rows once). No stamp, no git port, or a failure → none.
 */
async function readCommittedSince(
  source: WorkingTreeGitSignalSource | undefined,
  request: WorkingTreeDeltaSignalRequest,
): Promise<ReadonlySet<string> | undefined> {
  if (!source || !request.indexedCommit) return undefined;
  return source.pathsCommittedSince(request.tree.root, request.indexedCommit).catch(() => undefined);
}

/**
 * Git signals computed on demand for what no base point answers (D12):
 * `git.file` of a history path the base never chunked (below the chunk floor,
 * committed after the index, a move whose old path it never chunked), and
 * `git.chunk` of a row no base point of the same symbol answers — inheritance
 * stays wherever one does. A file whose history moved since the index (live G1)
 * is answered by no base point: its file and every row are computed. Asked
 * once per request, in the rows' TREE lines; an index without git asks
 * nothing. A failure answers nothing.
 */
async function readOnDemandGit(
  source: WorkingTreeGitSignalSource | undefined,
  request: WorkingTreeDeltaSignalRequest,
  base: BasePayload,
  historyOf: (path: string) => GitHistory,
): Promise<ReadonlyMap<string, WorkingTreeGitSignals>> {
  if (!source || !base.carriesGit) return new Map();
  const targets = new Map<
    string,
    WorkingTreeGitSignalTarget & { chunks: WorkingTreeGitSignalTarget["chunks"][number][] }
  >();
  const fileLines = treeFileLines(request.rows);
  for (const { id, payload } of request.rows) {
    const path = pathOf(payload);
    if (path === "") continue;
    const history = historyOf(path);
    const historyPath = history.path;
    const historyFile = history.moved ? undefined : base.byFile.get(historyPath);
    const wantFile = !historyFile?.gitFile;
    const { startLine, endLine } = payload;
    const hasLines = typeof startLine === "number" && typeof endLine === "number";
    const wantChunk = hasLines && !(historyFile && basePointOf(historyFile, payload.symbolId));
    if (!wantFile && !wantChunk) continue;
    let target = targets.get(historyPath);
    if (!target) {
      const lines = fileLines.get(path);
      target = {
        relativePath: historyPath,
        treePath: path,
        maxEndLine: 0,
        ...(lines !== undefined ? { fileLines: lines } : {}),
        fileSignals: wantFile,
        chunks: [],
      };
      targets.set(historyPath, target);
    }
    if (hasLines) {
      target.maxEndLine = Math.max(target.maxEndLine, endLine);
      if (wantChunk) target.chunks.push({ key: String(id), startLine, endLine });
    }
  }
  if (targets.size === 0) return new Map();
  // The stamp lets the source key each file by its own history (live C2); the
  // index's checkout, compute with the config that index was written with.
  return source
    .signalsOf(
      request.tree.root,
      [...targets.values()],
      request.indexedCommit,
      request.tree.baseIndex.root ?? request.tree.root,
    )
    .catch(() => new Map());
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

/** What a tree graph answers for every file alike: read once per graph file, whatever rows ask. */
interface GraphWideSignals {
  fanInP95: number;
  chunkSignals: Map<FileScopedSymbolId, ChunkGraphSignals>;
}

type TreeGraphDb = Awaited<ReturnType<WorkingTreeGraphFileOpener["acquireFileReader"]>>["graphDb"];

async function readGraphWideSignals(graphDb: TreeGraphDb): Promise<GraphWideSignals> {
  const fanInP95 = await graphDb.getFanInP95();
  return { fanInP95, chunkSignals: await graphDb.getChunkSignalsBulk() };
}

/**
 * The tree graph's signals for the delta's files: file metrics and fan-in p95
 * (over the FULL file universe, as every producer reads it), the whole graph's
 * chunk signals (there is no per-symbol bulk form), and the files' persisted
 * symbol ranges for the settlement. The graph-wide half comes from
 * `graphWideOf`, read once per graph file: the view enriches its rows file by
 * file as answers admit them (live C1), and each batch must not re-read the
 * whole graph.
 */
async function loadTreeSignals(
  opener: WorkingTreeGraphFileOpener,
  dbPath: string,
  paths: readonly string[],
  graphWideOf: (graphDb: TreeGraphDb) => Promise<GraphWideSignals>,
): Promise<TreeGraphSignals> {
  const { graphDb } = await opener.acquireFileReader(dbPath);
  try {
    const { fanInP95, chunkSignals } = await graphWideOf(graphDb);
    const metrics = await graphDb.getFileMetricsBulk(paths);
    const ranges = await graphDb.getSymbolLineRangesBulk(paths);
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

/**
 * Each tree file's line count as ingest computes file signals over it: the last
 * line its rows reach. The overlay hands a file's rows to one request whole.
 */
function treeLineCounts(rows: readonly WorkingTreeDeltaRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { payload } of rows) {
    const path = pathOf(payload);
    const { endLine } = payload;
    if (path === "" || typeof endLine !== "number") continue;
    counts.set(path, Math.max(counts.get(path) ?? 0, endLine));
  }
  return counts;
}

/**
 * Each tree file's line count as ingest's enrichment policy reads it
 * (`fileLinesOf` over every chunk of the file: `moduleLines`, else the last
 * row) — what decides a size-driven decline (`skippedAs: "oversized"`).
 */
function treeFileLines(rows: readonly WorkingTreeDeltaRow[]): Map<string, number> {
  const spans = new Map<string, { endLine: number; moduleLines?: number }[]>();
  for (const { payload } of rows) {
    const path = pathOf(payload);
    const { endLine, moduleLines } = payload;
    if (path === "" || typeof endLine !== "number") continue;
    const span = spans.get(path) ?? [];
    span.push(typeof moduleLines === "number" ? { endLine, moduleLines } : { endLine });
    spans.set(path, span);
  }
  const lines = new Map<string, number>();
  for (const [path, span] of spans) {
    const count = fileLinesOf(span);
    if (count !== undefined) lines.set(path, count);
  }
  return lines;
}

function enrichRow(
  row: WorkingTreeDeltaRow,
  base: ReadonlyMap<string, BaseFilePayload>,
  tree: TreeGraphSignals | undefined,
  history: GitHistory,
  onDemandGit: ReadonlyMap<string, WorkingTreeGitSignals>,
  lineCounts: ReadonlyMap<string, number>,
): WorkingTreeDeltaRow {
  const path = pathOf(row.payload);
  const file = base.get(path);
  const basePoint = file ? basePointOf(file, row.payload.symbolId) : undefined;
  const payload: Record<string, unknown> = { ...row.payload };

  // git follows the file's HISTORY path — its own, or the old path of a move.
  // A base point answers first, unless a commit since the index moved that
  // history; what none answers was computed on demand.
  const historyFile = history.moved ? undefined : base.get(history.path);
  const onDemand = onDemandGit.get(history.path);
  // A path no commit touched has no file block, only the walk's zero chunk
  // blocks — what ingest writes for an untracked file (live round-3 D4). An
  // inherited block keeps the base's history and takes the tree file's line
  // count, which a reindex of the tree computes `relativeChurn` over.
  const lineCount = lineCounts.get(path);
  const inheritedFile =
    historyFile?.gitFile && lineCount !== undefined
      ? gitFileSignalsAtLineCount(historyFile.gitFile, lineCount)
      : historyFile?.gitFile;
  const gitFile = inheritedFile ?? onDemand?.file;
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
