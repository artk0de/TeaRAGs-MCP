/**
 * Which graph a graph read goes to when the request reads a working tree (bd
 * tea-rags-mcp-xi2r9, WTO-7) — the one handle-selection rule `GraphFacade` and
 * `TracePathOps` share, kept out of both per facade discipline.
 *
 * A view whose delta is non-empty carries `readTreeGraph`. The read waits for
 * the tree graph up to {@link WORKING_TREE_GRAPH_WAIT_MS}; `built` → the SAME
 * read function runs against the tree's published file, attached READ_ONLY;
 * `unavailable` → the caller reads the base graph and the marker names why. A
 * clean or degraded view, or no view, never asks.
 *
 * A built graph that cannot be opened is a failure, not a fallback: the base
 * graph answers for a different commit, and saying so silently is exactly what
 * the base path refuses (`GraphFacade#readGraph`, bd tea-rags-mcp-kn2cb).
 */
import type { CollectionGraphHandle } from "../../../adapters/duckdb/pool.js";
import type { WorkingTreeGraphReader, WorkingTreeGraphState } from "../../../contracts/types/working-tree.js";
import { WORKING_TREE_GRAPH_BUILD_TIMEOUT_MS } from "./working-tree-graph-cache.js";

/**
 * How far a graph tool's wait outlasts the build budget. The budget is counted
 * from the child's fork, after the base snapshot is exported, and its kill
 * still has to be reaped and reported; a wait equal to the budget lapsed just
 * before that and answered `building` for a build that had in fact run out.
 */
export const WORKING_TREE_GRAPH_WAIT_MARGIN_MS = 10_000;

/**
 * How long a graph tool waits for the tree graph before answering from the
 * base: the build budget (spec: 120 s) plus {@link WORKING_TREE_GRAPH_WAIT_MARGIN_MS},
 * so a build that runs out of budget is reported with its reason, not as
 * still building.
 */
export const WORKING_TREE_GRAPH_WAIT_MS = WORKING_TREE_GRAPH_BUILD_TIMEOUT_MS + WORKING_TREE_GRAPH_WAIT_MARGIN_MS;

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

/** Wait for the tree graph and open it, or say the base graph answers. */
export async function selectWorkingTreeGraphHandle(
  readTreeGraph: WorkingTreeGraphReader | undefined,
  opener: WorkingTreeGraphFileOpener,
): Promise<WorkingTreeGraphHandleSelection> {
  if (!readTreeGraph) return { kind: "base" };
  const state = await readTreeGraph(WORKING_TREE_GRAPH_WAIT_MS);
  if (state.kind !== "built") return { kind: "base", state };
  return { kind: "tree", handle: await opener.acquireFileReader(state.dbPath), state };
}

/** `fn`'s answer from the tree graph, or `{ kind: "base" }` for the caller to read the base graph itself. */
export async function readWorkingTreeGraph<T>(
  readTreeGraph: WorkingTreeGraphReader | undefined,
  opener: WorkingTreeGraphFileOpener,
  fn: (handle: CollectionGraphHandle) => Promise<T>,
): Promise<{ kind: "tree"; value: T; state: WorkingTreeGraphState } | { kind: "base"; state?: WorkingTreeGraphState }> {
  const selection = await selectWorkingTreeGraphHandle(readTreeGraph, opener);
  if (selection.kind === "base") return selection;
  try {
    return { kind: "tree", value: await fn(selection.handle), state: selection.state };
  } finally {
    await selection.handle.graphDb.close().catch(() => undefined);
  }
}
