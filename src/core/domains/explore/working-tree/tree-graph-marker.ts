/**
 * How an answer's `workingTree` marker records which graph its graph data came
 * from (bd tea-rags-mcp-xi2r9, WTO-7) — stated once for every reader of the
 * tree graph: the graph tools, find_symbol's codegraph lookups, and the delta
 * rows' codegraph signals.
 *
 * Recorded by whoever USED the state, never by the read itself: a reader that
 * got `built` and then answered from the base anyway would otherwise leave a
 * `codegraph` floor on an answer the tree graph never touched.
 */
import {
  WORKING_TREE_SEARCH_GRAPH_WAIT_MS,
  type WorkingTreeFloor,
  type WorkingTreeGraphReader,
  type WorkingTreeGraphState,
  type WorkingTreeMarker,
} from "../../../contracts/types/working-tree.js";
import type { WorkingTreeDenseVectors } from "./dense-floor.js";
import type { WorkingTreeView } from "./overlay.js";

/** The order `floors` is listed in, whatever order the reads of one answer claimed them. */
const FLOOR_ORDER: readonly WorkingTreeFloor[] = ["chunks", "sparse", "dense", "codegraph"];

/**
 * Claim the floors of an answer whose rows the tree's delta rows supplied (live
 * D8, bd tea-rags-mcp-xi2r9): a floor names a layer that supplied tree data to
 * THIS answer, so it is claimed by the code that put delta rows into the
 * answer's candidates — never by reading them (find_similar reads them for a
 * tree positive's content and answers with base rows only), and never by a
 * clean tree, which has no rows to supply. `admittedRows` is how many delta
 * rows the caller put into its candidates: none — the request filter, the
 * pathPattern or the scroll predicate refused every one — claims nothing
 * (live round-3 D1: hybrid_search `language: "ruby"` on a TypeScript delta
 * answered `[]` claiming three floors). The rows carry the tree graph's
 * codegraph block when it was built, so their graph provenance is recorded
 * here too. Call after `readDeltaChunks` resolved.
 */
export function claimWorkingTreeFloors(
  view: WorkingTreeView,
  floors: readonly WorkingTreeFloor[],
  admittedRows: number,
): void {
  if (admittedRows <= 0) return;
  const claimed = new Set([...view.marker.floors, ...floors]);
  view.marker.floors = FLOOR_ORDER.filter((floor) => claimed.has(floor));
  if (view.deltaRowsTreeGraph) recordTreeGraphState(view.marker, view.deltaRowsTreeGraph);
}

/**
 * `built` → `floors` gains `"codegraph"` and any earlier unavailability is
 * cleared (one request may read twice — for its rows and for a lookup — each
 * waiting at most {@link WORKING_TREE_SEARCH_GRAPH_WAIT_MS}, so an earlier
 * read's `unavailable` can be followed by a later read's `built`). `unavailable` → `treeGraphUnavailable` names why, unless another
 * read of the same answer did use the tree graph. Mutates `marker`: the view's
 * marker is per request, and its other late fields (`unparsed`) are set the same way.
 */
export function recordTreeGraphState(marker: WorkingTreeMarker, state: WorkingTreeGraphState): void {
  if (state.kind === "built") {
    if (!marker.floors.includes("codegraph")) marker.floors = [...marker.floors, "codegraph"];
    delete marker.treeGraphUnavailable;
    return;
  }
  if (marker.floors.includes("codegraph")) return;
  marker.treeGraphUnavailable = state.reason;
}

/**
 * The view's tree-graph reader for a search/symbol LOOKUP handed to a seam that
 * reports only its data (find_symbol's tree definitions, codegraph hop and
 * visibility decoration go through `SymbolChunkResolver` /
 * `SymbolVisibilityResolver`, which read the graph `built` names). Undefined
 * when the view has no tree graph.
 *
 * Unlike a graph tool's read, a lookup's `built` does not claim `codegraph`
 * (live round-4 B1): it is parked on `view.treeGraphLookup` and clears any
 * earlier unavailability — the lookup did read the tree — and
 * {@link claimTreeGraphLookup} claims it only for an answer that returned a
 * row of a file the tree changed. `unavailable` is recorded at once: the
 * lookup fell back to the index whatever the answer holds, and the marker
 * says why.
 *
 * The wait it forwards is capped at {@link WORKING_TREE_SEARCH_GRAPH_WAIT_MS},
 * whatever the seam asked for (a seam shared with graph tools asks for the
 * build budget): an unbounded delta's tree-graph build can take tens of seconds
 * (live: a 1419-file delta held a find_symbol outline for 44.8 s), and a lookup
 * is a decoration/placement hop with an index fallback, not the answer. The
 * build keeps running past the cap, so a later call finds it built. The cap is
 * further clamped to what is left of the view's answer budget
 * (`WorkingTreeView#remainingWaitMs`): two lookups of one request — delta-row
 * signals and an outline's visibility, say — share one deadline instead of
 * waiting the cap each. Graph tools do not come through here and keep the
 * build-length wait.
 */
export function recordingTreeGraphReader(view: WorkingTreeView | undefined): WorkingTreeGraphReader | undefined {
  const read = view?.readTreeGraph;
  if (!view || !read) return undefined;
  return async (waitMs) => {
    const cap = Math.min(waitMs, WORKING_TREE_SEARCH_GRAPH_WAIT_MS);
    const state = await read(Math.min(cap, view.remainingWaitMs?.() ?? cap));
    if (state.kind === "built") {
      view.treeGraphLookup = state;
      delete view.marker.treeGraphUnavailable;
    } else if (!view.treeGraphLookup) {
      recordTreeGraphState(view.marker, state);
    }
    return state;
  };
}

/**
 * Claim the tree graph a lookup of this search/symbol answer read (D8, live
 * round-4 B1): `codegraph` names a layer that supplied tree data to a RETURNED
 * row, and only a row of a file the tree changed carries graph data the tree
 * graph derived — its definitions placed by the tree, its member visibility as
 * the tree declares it. A row of an untouched file holds the index's graph
 * data (the tree graph copies the base for it), and an empty answer holds
 * none, so neither claims. `answeredPaths` are the files of the rows the
 * answer returns. Graph tools never come here: their answer IS the tree
 * graph's, empty or not (`recordTreeGraphState`).
 */
export function claimTreeGraphLookup(view: WorkingTreeView, answeredPaths: Iterable<string>): void {
  const lookup = view.treeGraphLookup;
  if (!lookup) return;
  for (const path of answeredPaths) {
    if (view.touchedPaths.has(path) && !view.deletedPaths.has(path)) {
      recordTreeGraphState(view.marker, lookup);
      return;
    }
  }
}

/**
 * Record what the dense floor gave THIS answer (WTO-5): `scoredRows` delta rows
 * ranked by their own vectors claim the `chunks` and `dense` floors — none
 * claims nothing, as no tree row reached the candidates. Rows still without a
 * vector were left out of the ranking, so the marker names why
 * (`denseUnavailable`: the provider's failure, else how many are pending),
 * beside the claim when some rows did score.
 */
export function recordWorkingTreeDenseState(
  view: WorkingTreeView,
  dense: WorkingTreeDenseVectors,
  scoredRows: number,
): void {
  claimWorkingTreeFloors(view, ["chunks", "dense"], scoredRows);
  if (dense.pending > 0) {
    const pending = `${String(dense.pending)} ${dense.pending === 1 ? "row" : "rows"} pending`;
    view.marker.denseUnavailable = { reason: dense.failure ?? pending };
  }
}
