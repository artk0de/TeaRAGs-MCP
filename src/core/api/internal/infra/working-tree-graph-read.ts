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
  const state = await readTreeGraphState(readTreeGraph, remainingWaitMs);
  if (state.kind !== "built") return { kind: "base", state };
  return { kind: "tree", handle: await opener.acquireFileReader(state.dbPath), state };
}

/** The state read both handle paths share: the wait clamped to the search budget, whatever the seam asked for. */
async function readTreeGraphState(
  readTreeGraph: WorkingTreeGraphReader,
  remainingWaitMs?: () => number,
): Promise<WorkingTreeGraphState> {
  return readTreeGraph(Math.min(WORKING_TREE_GRAPH_WAIT_MS, remainingWaitMs?.() ?? WORKING_TREE_GRAPH_WAIT_MS));
}

/** The tree-graph handle one registered reader holds (bd tea-rags-mcp-4qdj0). */
interface TreeGraphLease {
  dbPath: string;
  handle: CollectionGraphHandle;
}

/**
 * Registered readers → the promise of their current lease. The promise chain
 * IS the serialization: concurrent reads chain off the stored promise, so an
 * open, a superseded swap and a release never interleave. The entry is also
 * the registration itself — a reader absent from the map is not leased.
 */
const treeGraphLeases = new WeakMap<WorkingTreeGraphReader, Promise<TreeGraphLease | undefined>>();

/**
 * Lease {@link readWorkingTreeGraph}'s tree-graph handles for one request's
 * reader (bd tea-rags-mcp-4qdj0): every read of a registered reader re-uses
 * ONE open READ_ONLY handle per dbPath, instead of paying the 12-23ms
 * open→query→close cycle of a ~600MB tree file per decoration-resolver call.
 * The reader registered must be the one closure the request's reads share
 * (`recordingTreeGraphReader` memoizes it per view), and the request seam MUST
 * {@link releaseWorkingTreeGraphLease} once its reads have settled — a leaked
 * lease holds the file open forever and blocks a superseded graph's deletion
 * (WTO-7/D5). Idempotent; a reader that was never registered keeps the
 * per-call open→query→close, and so does a read arriving after release.
 */
export function leaseWorkingTreeGraphReads(readTreeGraph: WorkingTreeGraphReader | undefined): void {
  if (!readTreeGraph || treeGraphLeases.has(readTreeGraph)) return;
  treeGraphLeases.set(readTreeGraph, Promise.resolve(undefined));
}

/**
 * Close the handle {@link leaseWorkingTreeGraphReads} leased for
 * `readTreeGraph` and forget the registration. Call when the request's reads
 * have settled (its `finally`): a read racing the release would find no lease
 * and degrade to the per-call open→query→close, and an in-flight query on the
 * leased handle would be closed under. Idempotent; a no-op for a reader that
 * never leased.
 */
export async function releaseWorkingTreeGraphLease(readTreeGraph: WorkingTreeGraphReader | undefined): Promise<void> {
  if (!readTreeGraph) return;
  const held = treeGraphLeases.get(readTreeGraph);
  treeGraphLeases.delete(readTreeGraph);
  const lease = await held?.catch(() => undefined);
  if (lease) await lease.handle.graphDb.close().catch(() => undefined);
}

/**
 * The registered reader's handle for `dbPath`: re-used across reads, swapped
 * (old closed, new opened) when the tree graph was superseded mid-request —
 * an in-flight query on the old file fails into the decoration layers'
 * existing degradation — and opened once however many reads race, because
 * every caller chains off the stored promise. A failed open rejects to its
 * readers like today's per-call open does and is retried by the next read.
 */
async function leasedTreeGraphHandle(
  readTreeGraph: WorkingTreeGraphReader,
  dbPath: string,
  opener: WorkingTreeGraphFileOpener,
): Promise<CollectionGraphHandle> {
  const previous = (treeGraphLeases.get(readTreeGraph) ?? Promise.resolve(undefined)).catch(() => undefined);
  const lease = previous.then(async (held) => {
    if (held?.dbPath === dbPath) return held;
    if (held) await held.handle.graphDb.close().catch(() => undefined);
    return { dbPath, handle: await opener.acquireFileReader(dbPath) };
  });
  treeGraphLeases.set(readTreeGraph, lease);
  return (await lease).handle;
}

/** `fn`'s answer from the tree graph, or `{ kind: "base" }` for the caller to read the base graph itself. */
export async function readWorkingTreeGraph<T>(
  readTreeGraph: WorkingTreeGraphReader | undefined,
  opener: WorkingTreeGraphFileOpener,
  fn: (handle: CollectionGraphHandle) => Promise<T>,
  remainingWaitMs?: () => number,
): Promise<{ kind: "tree"; value: T; state: WorkingTreeGraphState } | { kind: "base"; state?: WorkingTreeGraphState }> {
  // A registered reader leases: one handle for the request's reads, closed at
  // the seam's release (bd tea-rags-mcp-4qdj0) — never per read.
  if (readTreeGraph && treeGraphLeases.has(readTreeGraph)) {
    const state = await readTreeGraphState(readTreeGraph, remainingWaitMs);
    if (state.kind !== "built") return { kind: "base", state };
    const handle = await leasedTreeGraphHandle(readTreeGraph, state.dbPath, opener);
    return { kind: "tree", value: await fn(handle), state };
  }
  const selection = await selectWorkingTreeGraphHandle(readTreeGraph, opener, remainingWaitMs);
  if (selection.kind === "base") return selection;
  try {
    return { kind: "tree", value: await fn(selection.handle), state: selection.state };
  } finally {
    await selection.handle.graphDb.close().catch(() => undefined);
  }
}
