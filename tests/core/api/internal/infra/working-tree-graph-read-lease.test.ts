/**
 * working-tree-graph-read lease (bd tea-rags-mcp-4qdj0, iteration 3) — a
 * request may register its tree-graph reader for HANDLE LEASING: every read of
 * that reader re-uses one open READ_ONLY handle on the tree's graph file
 * instead of paying open+close (12-23ms on a 600MB file) per decoration
 * resolver call.
 *
 * Contract under test:
 *   - a leased reader opens the tree file ONCE per dbPath, however many reads
 *     the request makes, concurrent or staggered;
 *   - a superseded dbPath (the tree graph rebuilt mid-request) swaps: the old
 *     handle closes, the new one opens;
 *   - releaseWorkingTreeGraphLease closes the handle EXACTLY once — the
 *     open-reader count `ReadOnlyGraphFileReaders` tracks must drop, or a
 *     superseded graph can never be deleted (WTO-7/D5) — and is idempotent;
 *   - a reader that was never leased (or a read that arrives after release)
 *     keeps today's open→query→close per call, so nothing leaks;
 *   - an `unavailable` state mid-request answers from the base and keeps the
 *     leased handle for a later `built` read of the same request.
 */
import { describe, expect, it, vi } from "vitest";

import type { CollectionGraphHandle } from "../../../../../src/core/adapters/duckdb/pool.js";
import {
  leaseWorkingTreeGraphReads,
  readWorkingTreeGraph,
  releaseWorkingTreeGraphLease,
} from "../../../../../src/core/api/internal/infra/working-tree-graph-read.js";
import type { WorkingTreeGraphState } from "../../../../../src/core/contracts/types/working-tree.js";

const built = (dbPath: string): WorkingTreeGraphState =>
  ({ kind: "built", dbPath, physicalCollectionName: "c_v1" }) as WorkingTreeGraphState;

/** A reader whose states the test scripts per call. */
function readerOf(states: WorkingTreeGraphState[]) {
  let call = 0;
  return vi.fn(async () => states[Math.min(call++, states.length - 1)]);
}

/** Counting opener: every open is logged, every close observed per dbPath. */
function countingOpener() {
  const opens: string[] = [];
  const closes: string[] = [];
  const handles = new Map<string, CollectionGraphHandle>();
  return {
    opens,
    closes,
    handles,
    opener: {
      acquireFileReader: vi.fn(async (dbPath: string): Promise<CollectionGraphHandle> => {
        opens.push(dbPath);
        const handle = {
          graphDb: {
            close: vi.fn(async () => {
              closes.push(dbPath);
            }),
          },
        } as unknown as CollectionGraphHandle;
        handles.set(dbPath, handle);
        return handle;
      }),
    },
  };
}

describe("working-tree-graph-read lease (bd tea-rags-mcp-4qdj0)", () => {
  it("opens the tree file once for a leased reader's many reads and closes it only at release", async () => {
    const readTreeGraph = readerOf([built("/a.duckdb")]);
    const { opener, closes, handles } = countingOpener();
    leaseWorkingTreeGraphReads(readTreeGraph);

    const seen: CollectionGraphHandle[] = [];
    for (let i = 0; i < 3; i += 1) {
      const answer = await readWorkingTreeGraph(readTreeGraph, opener, async (handle) => {
        seen.push(handle);
        return i;
      });
      expect(answer.kind).toBe("tree");
    }

    expect(opener.acquireFileReader).toHaveBeenCalledTimes(1);
    expect(seen.every((handle) => handle === seen[0])).toBe(true);
    expect(seen[0]).toBe(handles.get("/a.duckdb"));
    expect(closes).toEqual([]); // the lease, not each read, owns the close

    await releaseWorkingTreeGraphLease(readTreeGraph);
    expect(closes).toEqual(["/a.duckdb"]);
  });

  it("coalesces concurrent reads of a leased reader into one open", async () => {
    const readTreeGraph = readerOf([built("/a.duckdb")]);
    const { opener } = countingOpener();
    leaseWorkingTreeGraphReads(readTreeGraph);

    await Promise.all([1, 2, 3, 4].map(async (n) => readWorkingTreeGraph(readTreeGraph, opener, async () => n)));

    expect(opener.acquireFileReader).toHaveBeenCalledTimes(1);
    await releaseWorkingTreeGraphLease(readTreeGraph);
  });

  it("swaps the handle when the tree graph is superseded mid-request", async () => {
    const readTreeGraph = readerOf([built("/v1.duckdb"), built("/v2.duckdb")]);
    const { opener, opens, closes, handles } = countingOpener();
    leaseWorkingTreeGraphReads(readTreeGraph);

    const first = await readWorkingTreeGraph(readTreeGraph, opener, async (h) => h);
    const second = await readWorkingTreeGraph(readTreeGraph, opener, async (h) => h);
    const handleOf = (answer: Awaited<ReturnType<typeof readWorkingTreeGraph<CollectionGraphHandle>>>) =>
      answer.kind === "tree" ? answer.value : undefined;

    expect(opens).toEqual(["/v1.duckdb", "/v2.duckdb"]);
    expect(closes).toEqual(["/v1.duckdb"]); // the superseded file closed at the swap
    expect(handleOf(first)).toBe(handles.get("/v1.duckdb"));
    expect(handleOf(second)).toBe(handles.get("/v2.duckdb"));

    await releaseWorkingTreeGraphLease(readTreeGraph);
    expect(closes).toEqual(["/v1.duckdb", "/v2.duckdb"]);
  });

  it("release closes exactly once and is idempotent", async () => {
    const readTreeGraph = readerOf([built("/a.duckdb")]);
    const { opener, closes } = countingOpener();
    leaseWorkingTreeGraphReads(readTreeGraph);
    await readWorkingTreeGraph(readTreeGraph, opener, async () => 1);

    await releaseWorkingTreeGraphLease(readTreeGraph);
    await releaseWorkingTreeGraphLease(readTreeGraph);

    expect(closes).toEqual(["/a.duckdb"]);
  });

  it("a read that arrives after release falls back to open→query→close per call (nothing leaks)", async () => {
    const readTreeGraph = readerOf([built("/a.duckdb")]);
    const { opener, opens, closes } = countingOpener();
    leaseWorkingTreeGraphReads(readTreeGraph);
    await readWorkingTreeGraph(readTreeGraph, opener, async () => 1);
    await releaseWorkingTreeGraphLease(readTreeGraph);

    const late = await readWorkingTreeGraph(readTreeGraph, opener, async () => 2);

    expect(late.kind).toBe("tree");
    expect(opens).toEqual(["/a.duckdb", "/a.duckdb"]);
    expect(closes).toEqual(["/a.duckdb", "/a.duckdb"]); // release + the late read's own close
  });

  it("keeps open→query→close per read for a reader that was never leased", async () => {
    const readTreeGraph = readerOf([built("/a.duckdb")]);
    const { opener, opens, closes } = countingOpener();

    await readWorkingTreeGraph(readTreeGraph, opener, async () => 1);
    await readWorkingTreeGraph(readTreeGraph, opener, async () => 2);

    expect(opens).toEqual(["/a.duckdb", "/a.duckdb"]);
    expect(closes).toEqual(["/a.duckdb", "/a.duckdb"]);
  });

  it("an unavailable state mid-request answers from the base and keeps the leased handle", async () => {
    const readTreeGraph = readerOf([built("/a.duckdb"), { kind: "unavailable", reason: "building" }]);
    const { opener, closes } = countingOpener();
    leaseWorkingTreeGraphReads(readTreeGraph);
    await readWorkingTreeGraph(readTreeGraph, opener, async () => 1);

    const fallback = await readWorkingTreeGraph(readTreeGraph, opener, async () => 2);

    expect(fallback.kind).toBe("base");
    expect(closes).toEqual([]); // the lease outlives one unavailable read

    await releaseWorkingTreeGraphLease(readTreeGraph);
    expect(closes).toEqual(["/a.duckdb"]);
  });
});
