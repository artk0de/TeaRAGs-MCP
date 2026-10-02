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
import type {
  WorkingTreeGraphReader,
  WorkingTreeGraphState,
  WorkingTreeMarker,
} from "../../../contracts/types/working-tree.js";
import type { WorkingTreeView } from "./overlay.js";

/**
 * `built` → `floors` gains `"codegraph"` and any earlier unavailability is
 * cleared (one request may wait twice: 3 s for its rows, 120 s for a graph
 * lookup). `unavailable` → `treeGraphUnavailable` names why, unless another
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
 * The view's tree-graph reader, recording what it answers on the view's marker
 * — for a lookup handed to a seam that reports only its data (find_symbol's
 * codegraph hop and visibility decoration go through `SymbolChunkResolver` /
 * `SymbolVisibilityResolver`, which read the graph `built` names). Undefined
 * when the view has no tree graph.
 */
export function recordingTreeGraphReader(view: WorkingTreeView | undefined): WorkingTreeGraphReader | undefined {
  const read = view?.readTreeGraph;
  if (!view || !read) return undefined;
  return async (waitMs) => {
    const state = await read(waitMs);
    recordTreeGraphState(view.marker, state);
    return state;
  };
}
