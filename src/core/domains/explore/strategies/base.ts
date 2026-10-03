/**
 * BaseExploreStrategy — abstract base for all explore strategies.
 *
 * Template Method pattern:
 *   execute() = applyDefaults() → executeExplore() → postProcess()
 *
 * Concrete strategies implement only `executeExplore()` and `type`.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { fileScopeOf, reduceToFileScope, type FileScope } from "../chunk-grouping/file-scope.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import { filterMetaOnly } from "../post-process.js";
import type { Reranker, RerankMode } from "../reranker.js";
import { TestSetupHydrator } from "../test-setup-hydration.js";
import { WORKING_TREE_DENSE_WAIT_MS, type WorkingTreeDenseVectors } from "../working-tree/dense-floor.js";
import { filterReadsWorkingTreeSignals, type WorkingTreeView } from "../working-tree/overlay.js";
import { excludeWorkingTreeBaseIds } from "../working-tree/sparse-floor.js";
import {
  relativePathOf,
  retargetWorkingTreeRows,
  substituteWorkingTreeRows,
  workingTreeStateOf,
} from "../working-tree/substitute.js";
import { touchedBasePointIds, WorkingTreeTouchedBasePoints } from "../working-tree/touched-base-points.js";
import {
  claimTreeGraphLookup,
  claimWorkingTreeFloors,
  recordTreeGraphState,
} from "../working-tree/tree-graph-marker.js";
import type { ExploreContext, ExploreResult, ExploreStrategy } from "./types.js";

/** What a dense-floor strategy reads from its view: the tree's rows and their vectors (WTO-5). */
export interface WorkingTreeDenseFloorRead {
  view: WorkingTreeView;
  rows: readonly ScrollChunk[];
  /**
   * The rows' vectors, waiting at most {@link WORKING_TREE_DENSE_WAIT_MS} —
   * a promise, so the Qdrant request runs while the vectors are awaited.
   * Never rejects.
   */
  dense: Promise<WorkingTreeDenseVectors>;
}

/** `rows` signalled by the view, or as they are when it has no signal source. */
async function signalDeltaRows(view: WorkingTreeView, rows: readonly ScrollChunk[]): Promise<readonly ScrollChunk[]> {
  return view.signalDeltaRows ? view.signalDeltaRows(rows) : rows;
}

/** Page size when the caller gives no (or a non-positive) limit. */
const FALLBACK_PAGE_SIZE = 5;

/**
 * The page size the CALLER asked for. A positive limit is honoured exactly —
 * the overfetch floor lives in `applyDefaults`' fetch size, never in the page
 * (tea-rags-mcp-9mwny: a `Math.max(limit, 5)` here returned 5 results for
 * limit 1/2/3 on every strategy that inherits postProcess).
 */
function requestedPageSize(limit: number | undefined): number {
  return limit !== undefined && limit > 0 ? limit : FALLBACK_PAGE_SIZE;
}

export abstract class BaseExploreStrategy implements ExploreStrategy {
  abstract readonly type: "vector" | "hybrid" | "scroll-rank" | "similar";

  /** Payload keys a `level: "file"` hit keeps, derived once from payloadSignals. */
  private readonly fileScope: FileScope;

  /** Puts a test example's scope setup back in front of it (bd tea-rags-mcp-5xpq4). */
  private readonly testSetupHydrator: TestSetupHydrator;

  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly reranker: Reranker,
    protected readonly payloadSignals: PayloadSignalDescriptor[],
    protected readonly essentialKeys: string[],
  ) {
    this.fileScope = fileScopeOf(payloadSignals);
    this.testSetupHydrator = new TestSetupHydrator(qdrant);
  }

  /**
   * Whether this strategy has the working-tree CHUNK floor: it substitutes the
   * tree's rows for base rows of delta files (`substituteFromWorkingTree`, or
   * hybrid's sparse floor on top of it) instead of flagging them with `treeState`.
   */
  protected readonly hasChunkFloor: boolean = false;

  /** Touched-file base points for a view without a reader wired; built on first use. */
  private ownTouchedBasePoints?: WorkingTreeTouchedBasePoints;

  /**
   * Whether this strategy answers `view`'s touched files from the tree (it has
   * a floor and the view can supply what that floor reads) rather than
   * flagging their base rows with `treeState`. The chunk-floor strategies need
   * the delta rows; the dense-floor ones override to need their vectors too.
   */
  protected hasWorkingTreeFloor(view: WorkingTreeView): boolean {
    return this.hasChunkFloor && view.readDeltaChunks !== undefined;
  }

  /**
   * `filter` with the base points of every file `view` touched excluded by ONE
   * `has_id` (bd tea-rags-mcp-xi2r9) — the ids from the view's shared read, or
   * this strategy's own reader (same cache rules) when the view has none wired.
   */
  protected async excludeWorkingTreeBase(
    ctx: ExploreContext,
    view: WorkingTreeView,
    filter: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const read =
      view.readTouchedBasePoints?.() ??
      (this.ownTouchedBasePoints ??= new WorkingTreeTouchedBasePoints(this.qdrant)).pointsOf(
        ctx.collectionName,
        view.touchedPaths,
        view.marker.indexedCommit,
      );
    return excludeWorkingTreeBaseIds(filter, touchedBasePointIds(await read));
  }

  /**
   * The dense floor's read (WTO-5): the tree's rows, and their vectors waiting
   * at most {@link WORKING_TREE_DENSE_WAIT_MS}. Undefined when the request
   * reads no tree, the tree touched nothing, or the view cannot supply rows and
   * vectors — the strategy then answers as before the floor.
   */
  protected async readWorkingTreeDenseFloor(ctx: ExploreContext): Promise<WorkingTreeDenseFloorRead | undefined> {
    const view = ctx.workingTreeView;
    if (!view?.readDeltaChunks || !view.readDeltaVectors || view.touchedPaths.size === 0) return undefined;
    const dense = view.readDeltaVectors(WORKING_TREE_DENSE_WAIT_MS);
    return { view, rows: await this.readWorkingTreeRowsAdmittedBy(view, ctx.filter), dense };
  }

  /**
   * The view's delta rows for a floor that admits them by `requestFilter`:
   * structure only, unless the filter names a trajectory key — then every row
   * is signalled first, or the filter would refuse rows whose indexed twins it
   * admits. The rows that reach the answer are signalled by `execute` either way.
   */
  protected async readWorkingTreeRowsAdmittedBy(
    view: WorkingTreeView,
    requestFilter: Record<string, unknown> | undefined,
  ): Promise<readonly ScrollChunk[]> {
    const rows = (await view.readDeltaChunks?.()) ?? [];
    return filterReadsWorkingTreeSignals(requestFilter) ? signalDeltaRows(view, rows) : rows;
  }

  /**
   * Main entry point: apply defaults → execute search → signal the tree's rows
   * among the candidates → post-process → flag base rows of delta files the
   * strategy did not substitute.
   */
  async execute(ctx: ExploreContext): Promise<ExploreResult[]> {
    const prepared = this.applyDefaults(ctx);
    const rawResults = await this.signalWorkingTreeCandidates(await this.executeExplore(prepared), ctx);
    const processed = await this.postProcess(rawResults, ctx);
    this.claimWorkingTreeGraphLookup(processed, rawResults, ctx);
    return this.markWorkingTreeState(processed, rawResults, ctx);
  }

  /**
   * The ONE seam where a search/symbol answer claims the tree graph its
   * lookups read (D8, live round-4 B1): only when the page returns a row of a
   * file the tree changed — `claimTreeGraphLookup`. The file is read off the
   * RAW hit by id when page shaping dropped `relativePath`.
   */
  private claimWorkingTreeGraphLookup(
    results: readonly ExploreResult[],
    rawResults: readonly ExploreResult[],
    ctx: ExploreContext,
  ): void {
    const view = ctx.workingTreeView;
    if (!view?.treeGraphLookup) return;
    const rawPathById = new Map(rawResults.map((raw) => [raw.id, relativePathOf(raw.payload)]));
    claimTreeGraphLookup(
      view,
      results.map((result) => relativePathOf(result.payload) || rawPathById.get(result.id) || ""),
    );
  }

  /**
   * The ONE seam where the tree's rows get their trajectory payload (live C1,
   * bd tea-rags-mcp-xi2r9): the candidates `executeExplore` hands to rerank and
   * the page — and only their files — are signalled, so an answer pays git for
   * the files it returns, never for the whole delta. Rows a strategy ranked or
   * admitted by signals inside `executeExplore` were signalled there already
   * (`substituteFromWorkingTree`, `readWorkingTreeRowsAdmittedBy`) and pass
   * through unchanged. The graph their codegraph block came from is recorded
   * here, where the rows reach the answer (D8).
   */
  private async signalWorkingTreeCandidates(rows: ExploreResult[], ctx: ExploreContext): Promise<ExploreResult[]> {
    const view = ctx.workingTreeView;
    if (!view?.signalDeltaRows || view.touchedPaths.size === 0 || !this.hasWorkingTreeFloor(view)) return rows;
    if (!rows.some((row) => view.touchedPaths.has(relativePathOf(row.payload)))) return rows;
    const signalled = await view.signalDeltaRows(rows);
    if (view.deltaRowsTreeGraph) recordTreeGraphState(view.marker, view.deltaRowsTreeGraph);
    return signalled;
  }

  /**
   * Base rows of a file the working tree changed or deleted stay in an answer
   * that has no floor, and say so: `treeState` on the RESULT, never inside the
   * payload, so `fields` projection and metaOnly shaping cannot drop it
   * (bd tea-rags-mcp-xi2r9.3). One stamping seam for every strategy — a
   * floor strategy whose view can read delta rows answered from the tree, so
   * there is nothing stale to flag. The file is read off the RAW hit by id:
   * metaOnly and `level: "file"` shaping may have dropped `relativePath` from
   * the page's payload.
   */
  private markWorkingTreeState(
    results: ExploreResult[],
    rawResults: readonly ExploreResult[],
    ctx: ExploreContext,
  ): ExploreResult[] {
    const view = ctx.workingTreeView;
    if (!view || view.touchedPaths.size === 0) return results;
    if (this.hasWorkingTreeFloor(view)) return results;
    const rawPathById = new Map(rawResults.map((raw) => [raw.id, relativePathOf(raw.payload)]));
    return results.map((result) => {
      const path = relativePathOf(result.payload) || rawPathById.get(result.id);
      const treeState = workingTreeStateOf(view, path);
      return treeState ? { ...result, treeState } : result;
    });
  }

  /**
   * The chunk floor (bd tea-rags-mcp-xi2r9.3): `scrolled` with the base rows of
   * delta files replaced by the tree's rows that pass `keep` — the predicate
   * the caller's Qdrant scroll applied. Untouched when the request reads no
   * tree, the tree touched nothing, or no chunk layer can read its rows (the
   * base rows then stay and `execute` flags them instead).
   *
   * The admitted rows come back signalled: the callers group or rank them
   * before `execute` sees a candidate (rank_chunks ranks the pool inside, an
   * outline folds rows into one hit). `keepReadsSignals` — `keep` reads a
   * trajectory key (rank_chunks' leg filters), so every row is signalled
   * before it is judged.
   */
  protected async substituteFromWorkingTree(
    scrolled: readonly ScrollChunk[],
    ctx: ExploreContext,
    keep: (row: ScrollChunk) => boolean,
    keepReadsSignals = false,
  ): Promise<ScrollChunk[]> {
    const view = ctx.workingTreeView;
    if (!view?.readDeltaChunks || view.touchedPaths.size === 0) return [...scrolled];
    const rows = await view.readDeltaChunks();
    const pool = keepReadsSignals ? await signalDeltaRows(view, rows) : rows;
    const admitted = await signalDeltaRows(view, pool.filter(keep));
    claimWorkingTreeFloors(view, ["chunks"], admitted.length);
    return substituteWorkingTreeRows(scrolled, view, admitted, () => true);
  }

  /**
   * Retarget the rows of a base-only leg of a floor strategy at the tree (live
   * P2-1): a row of a file the tree touched becomes the tree's rows of the same
   * symbol, or nothing — `retargetWorkingTreeRows`. Untouched when the strategy
   * has no floor or the view cannot read delta rows.
   */
  protected async retargetToWorkingTree(
    rows: ExploreResult[],
    ctx: ExploreContext,
    toResult: (row: ScrollChunk) => ExploreResult,
  ): Promise<ExploreResult[]> {
    const view = ctx.workingTreeView;
    if (!view?.readDeltaChunks || !this.hasWorkingTreeFloor(view) || view.touchedPaths.size === 0) return rows;
    if (!rows.some((row) => view.touchedPaths.has(relativePathOf(row.payload)))) return rows;
    const retargeted = retargetWorkingTreeRows(rows, view, await view.readDeltaChunks(), toResult);
    const admitted = retargeted.filter((row) => view.touchedPaths.has(relativePathOf(row.payload)));
    claimWorkingTreeFloors(view, ["chunks"], admitted.length);
    return retargeted;
  }

  /** Concrete strategy implements the actual search call. */
  protected abstract executeExplore(ctx: ExploreContext): Promise<ExploreResult[]>;

  /**
   * Apply defaults to context before passing to executeExplore.
   * - Computes the FETCH size: overfetch ×4 with a non-relevance rerank, ×2
   *   otherwise, never below 20 — so a small page still reranks a real pool
   */
  protected applyDefaults(ctx: ExploreContext): ExploreContext {
    const requestedLimit = requestedPageSize(ctx.limit);
    const effectiveOffset = ctx.offset || 0;
    const rerank = ctx.rerank as RerankMode<string> | undefined;
    const needsOverfetch = Boolean(rerank && rerank !== "relevance");
    const multiplier = needsOverfetch ? 4 : 2;
    const fetchLimit = Math.max(20, (requestedLimit + effectiveOffset) * multiplier);
    return { ...ctx, limit: fetchLimit };
  }

  /**
   * Post-process raw results:
   *   1. Rerank (if non-relevance preset)
   *   2. Trim to requested limit
   *   3. Reduce file-level hits to file scope (after ranking — see `shapeFileLevel`)
   *   4. metaOnly formatting (if ctx.metaOnly), else test setup hydration
   */
  protected async postProcess(results: ExploreResult[], originalCtx: ExploreContext): Promise<ExploreResult[]> {
    const requestedLimit = requestedPageSize(originalCtx.limit);
    const rerank = originalCtx.rerank as RerankMode<string> | undefined;

    // 1. Rerank
    let filtered =
      rerank && rerank !== "relevance"
        ? await this.reranker.rerank(results, rerank, "semantic_search", {
            signalLevel: originalCtx.level,
            query: originalCtx.query,
          })
        : results;

    // 2. Offset + trim to requested limit
    const effectiveOffset = originalCtx.offset || 0;
    if (effectiveOffset > 0) {
      filtered = filtered.slice(effectiveOffset);
    }
    filtered = filtered.slice(0, requestedLimit);

    // 3. File scope
    filtered = this.shapeFileLevel(filtered, originalCtx);

    // 4. metaOnly formatting
    if (originalCtx.metaOnly) {
      return this.applyMetaOnly(filtered);
    }

    return this.hydrateTestSetup(filtered, originalCtx);
  }

  /**
   * The final page with every test example's scope setup prepended to its
   * content (bd tea-rags-mcp-5xpq4) — ONE batched fetch per page. The single
   * hydration seam: every strategy calls it as the last step of a
   * content-bearing answer, after ranking, slicing and file-scope shaping, so
   * only the returned page pays and a file-level hit (no `content`, no
   * `parentType` left after file scoping) never does. A metaOnly answer
   * carries no content and never calls it.
   */
  protected async hydrateTestSetup(results: ExploreResult[], ctx: ExploreContext): Promise<ExploreResult[]> {
    // A floor strategy's examples of touched files are the tree's rows, so
    // their setup is too (bd tea-rags-mcp-xi2r9.3). Without a floor they are
    // the index's rows, flagged by `treeState`, and the index's setup matches them.
    const view = ctx.workingTreeView && this.hasWorkingTreeFloor(ctx.workingTreeView) ? ctx.workingTreeView : undefined;
    return this.testSetupHydrator.hydrate(results, ctx.collectionName, view);
  }

  /**
   * At `level: "file"`, reduce each hit's payload to the fields describing the
   * file (bd tea-rags-mcp-mwq0k). Runs AFTER rerank: ranking reads the full
   * representative chunk payload, the response carries only file scope.
   * `rankingOverlay` is a sibling of the payload and passes through untouched.
   */
  protected shapeFileLevel(results: ExploreResult[], ctx: ExploreContext): ExploreResult[] {
    if (ctx.level !== "file") return results;
    return results.map((result) =>
      result.payload ? { ...result, payload: reduceToFileScope(result.payload, this.fileScope) } : result,
    );
  }

  /**
   * Apply metaOnly formatting: strip raw content, keep metadata from payloadSignals.
   * Wraps filterMetaOnly output back as ExploreResult[]; the score stays on the
   * hit, never copied into its payload (bd tea-rags-mcp-947xf). The
   * rankingOverlay stays too: the metaOnly payload is raw, so the overlay is
   * the only place a reranked hit's labels live.
   */
  protected applyMetaOnly(results: ExploreResult[]): ExploreResult[] {
    const metaResults = filterMetaOnly(results, this.payloadSignals, this.essentialKeys);
    return metaResults.map((meta, i) => {
      const { id, score, rankingOverlay } = results[i];
      return rankingOverlay ? { id, score, payload: meta, rankingOverlay } : { id, score, payload: meta };
    });
  }
}
