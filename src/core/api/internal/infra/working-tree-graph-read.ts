/**
 * Which graph a graph read goes to when the request reads a working tree (bd
 * tea-rags-mcp-xi2r9, WTO-7) — the one handle-selection rule `GraphFacade` and
 * `TracePathOps` share, kept out of both per facade discipline.
 *
 * A view whose delta is non-empty carries `readTreeGraph`. The read waits for
 * the tree graph up to {@link WORKING_TREE_GRAPH_WAIT_MS}, clamped to what is
 * left of the view's answer budget; `built` → the SAME read function runs
 * against the tree's published file, attached READ_ONLY; `unavailable` → the
 * caller reads the base graph, the marker names why, and the build keeps
 * running for a later call (bd tea-rags-mcp-07b9w). A clean or degraded view,
 * or no view, never asks.
 *
 * A built graph that cannot be opened is a failure, not a fallback: the base
 * graph answers for a different commit, and saying so silently is exactly what
 * the base path refuses (`GraphFacade#readGraph`, bd tea-rags-mcp-kn2cb).
 */
import type { CollectionGraphHandle } from "../../../adapters/duckdb/pool.js";
import {
  WORKING_TREE_SEARCH_GRAPH_WAIT_MS,
  type WorkingTreeGraphReader,
  type WorkingTreeGraphState,
} from "../../../contracts/types/working-tree.js";

/**
 * How long a graph tool waits for the tree graph before answering from the
 * base: the search answers' wait (bd tea-rags-mcp-07b9w). A build that outlasts
 * it keeps running and serves a later call; waiting out the build budget
 * (120 s) blocked every graph call behind a delta the child could not finish.
 */
export const WORKING_TREE_GRAPH_WAIT_MS = WORKING_TREE_SEARCH_GRAPH_WAIT_MS;

/** The pool surface the tree graph is opened through. */
export interface WorkingTreeGraphFileOpener {
  acquireFileReader: (dbPath: string) => Promise<CollectionGraphHandle>;
}

/**
 * A handle on the tree graph (`tree`, caller closes it), or the verdict that
 * the base graph answers (`base`) — with the tree-graph state that decided it,
 * absent when no tree graph was asked for.
 */
export type WorkingTreeGraphHandleSelection =
  | { kind: "tree"; handle: CollectionGraphHandle; state: WorkingTreeGraphState }
  | { kind: "base"; state?: WorkingTreeGraphState };

/**
 * Wait for the tree graph and open it, or say the base graph answers. The wait
 * is {@link WORKING_TREE_GRAPH_WAIT_MS}, clamped to `remainingWaitMs` — the
 * view's answer budget — when given.
 */
export async function selectWorkingTreeGraphHandle(
  readTreeGraph: WorkingTreeGraphReader | undefined,
  opener: WorkingTreeGraphFileOpener,
  remainingWaitMs?: () => number,
): Promise<WorkingTreeGraphHandleSelection> {
  if (!readTreeGraph) return { kind: "base" };
  const state = await readTreeGraph(
    Math.min(WORKING_TREE_GRAPH_WAIT_MS, remainingWaitMs?.() ?? WORKING_TREE_GRAPH_WAIT_MS),
  );
  if (state.kind !== "built") return { kind: "base", state };
  return { kind: "tree", handle: await opener.acquireFileReader(state.dbPath), state };
}

/** `fn`'s answer from the tree graph, or `{ kind: "base" }` for the caller to read the base graph itself. */
export async function readWorkingTreeGraph<T>(
  readTreeGraph: WorkingTreeGraphReader | undefined,
  opener: WorkingTreeGraphFileOpener,
  fn: (handle: CollectionGraphHandle) => Promise<T>,
  remainingWaitMs?: () => number,
): Promise<{ kind: "tree"; value: T; state: WorkingTreeGraphState } | { kind: "base"; state?: WorkingTreeGraphState }> {
  const selection = await selectWorkingTreeGraphHandle(readTreeGraph, opener, remainingWaitMs);
  if (selection.kind === "base") return selection;
  try {
    return { kind: "tree", value: await fn(selection.handle), state: selection.state };
  } finally {
    await selection.handle.graphDb.close().catch(() => undefined);
  }
}
