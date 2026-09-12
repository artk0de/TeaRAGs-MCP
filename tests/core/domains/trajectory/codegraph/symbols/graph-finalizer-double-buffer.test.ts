/**
 * GraphBuildFinalizer pass-2 double-buffered flush (bd tea-rags-mcp-6aytq).
 *
 * Measured on taxdome (10,476 TS files): the bulk flush was awaited INLINE in
 * the resolve loop — 44.0s across 42 calls, i.e. ~1s of dead wall clock every
 * BULK_FILES=256 files while the daemon committed the transaction and the
 * resolver sat idle. The loop now dispatches the flush and keeps resolving into
 * a fresh buffer, awaiting the in-flight write only when the NEXT one is ready
 * to go out.
 *
 * The invariants that make that safe are what these tests pin:
 *   - exactly ONE flush in flight (the daemon session never sees two concurrent
 *     bulk writes, and batch order is preserved),
 *   - a checkpoint runs only after the flushes covering its window settled,
 *   - a dispatched flush settles before a resolve error propagates,
 *   - the final partial batch still lands,
 *   - `flush` telemetry now measures the AWAITED stall only — the hidden
 *     portion disappearing from it is the win being measured.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  BulkFileUpsertEntry,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  GraphEdges,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  GraphBuildFinalizer,
  type GraphStoreResolver,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/graph-finalizer.js";
import {
  CodegraphPhaseTimings,
  type CodegraphPhaseTotal,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/phase-timings.js";
import type { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const NO_EDGES: GraphEdges = { fileEdges: [], methodEdges: [] };

function extraction(relPath: string): FileExtraction {
  return { relPath, language: "typescript", imports: [], chunks: [], fileScope: [] };
}

/** Resolution runner that records the order files were resolved in. */
function recordingRunner(log: string[], onResolve?: (relPath: string) => void): CallEdgeResolutionRunner {
  return {
    prepareResolvePass: () => undefined,
    resolve: (e: FileExtraction): GraphEdges => {
      log.push(`resolve:${e.relPath}`);
      onResolve?.(e.relPath);
      return NO_EDGES;
    },
  } as unknown as CallEdgeResolutionRunner;
}

function makeFinalizer(
  graphDb: GraphDbClient,
  resolutionRunner: CallEdgeResolutionRunner,
  timings = new CodegraphPhaseTimings(),
): GraphBuildFinalizer {
  const resolveStore: GraphStoreResolver = async () => ({ graphDb, symbolTable: {} as GlobalSymbolTable });
  return new GraphBuildFinalizer(resolveStore, resolutionRunner, new CodegraphRunState(), timings);
}

describe("GraphBuildFinalizer pass-2 double-buffered flush (bd tea-rags-mcp-6aytq)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "graph-finalizer-db-"));
    process.env.CODEGRAPH_BULK_FILES = "1";
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.CODEGRAPH_BULK_FILES;
    delete process.env.CODEGRAPH_CHECKPOINT_EVERY;
  });

  function writeSpill(relPaths: string[]): string {
    const spillPath = join(tmp, "spill.ndjson");
    writeFileSync(spillPath, `${relPaths.map((p) => JSON.stringify(extraction(p))).join("\n")}\n`);
    return spillPath;
  }

  it("keeps resolving into a fresh buffer while the previous flush is still in flight", async () => {
    const log: string[] = [];
    const gates: (() => void)[] = [];
    const graphDb = {
      upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]) => {
        log.push(`flush:start:${entries[0]?.node.relPath}`);
        await new Promise<void>((resolve) => gates.push(resolve));
        log.push(`flush:end:${entries[0]?.node.relPath}`);
      },
      checkpoint: async () => undefined,
    } as unknown as GraphDbClient;

    const finalizer = makeFinalizer(graphDb, recordingRunner(log));
    const run = finalizer.resolveAndUpsert(writeSpill(["a.ts", "b.ts"]));

    // Let the loop reach the point where it can go no further without a settle.
    await waitFor(() => log.includes("resolve:b.ts"));

    // The whole point: b was resolved while a's flush was still open — under an
    // inline await the loop could not have reached b at all.
    expect(log).toContain("resolve:b.ts");
    expect(log).not.toContain("flush:end:a.ts");

    // Release everything and let the pass finish.
    while (gates.length > 0 || !log.includes("flush:end:b.ts")) {
      gates.shift()?.();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    await run;
    expect(log.filter((l) => l.startsWith("flush:start"))).toEqual(["flush:start:a.ts", "flush:start:b.ts"]);
  });

  it("never opens a second bulk write before the previous one settled (order preserved, one in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const graphDb = {
      upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(entries[0]?.node.relPath ?? "?");
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
      checkpoint: async () => undefined,
    } as unknown as GraphDbClient;

    const finalizer = makeFinalizer(graphDb, recordingRunner([]));
    await finalizer.resolveAndUpsert(writeSpill(["a.ts", "b.ts", "c.ts", "d.ts"]));

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  it("checkpoints only after the flush covering that window has landed", async () => {
    process.env.CODEGRAPH_CHECKPOINT_EVERY = "2";
    const log: string[] = [];
    const graphDb = {
      upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]) => {
        await new Promise((r) => setTimeout(r, 1));
        log.push(`flush:${entries[0]?.node.relPath}`);
      },
      checkpoint: async () => {
        log.push("checkpoint");
      },
      rebuildEdgeFileTargetIndex: async () => undefined,
    } as unknown as GraphDbClient;

    const finalizer = makeFinalizer(graphDb, recordingRunner([]));
    await finalizer.resolveAndUpsert(writeSpill(["a.ts", "b.ts"]));

    // Both files' writes are on disk before the CHECKPOINT bounding the WAL.
    expect(log.indexOf("checkpoint")).toBeGreaterThan(log.indexOf("flush:b.ts"));
    expect(log.indexOf("flush:b.ts")).toBeGreaterThan(log.indexOf("flush:a.ts"));
  });

  it("settles the dispatched flush before a resolve failure propagates", async () => {
    const log: string[] = [];
    const graphDb = {
      upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]) => {
        await new Promise((r) => setTimeout(r, 5));
        log.push(`flush:${entries[0]?.node.relPath}`);
      },
      checkpoint: async () => undefined,
    } as unknown as GraphDbClient;

    let calls = 0;
    const runner = {
      prepareResolvePass: () => undefined,
      resolve: (): GraphEdges => {
        calls += 1;
        if (calls === 2) throw new Error("resolver exploded");
        return NO_EDGES;
      },
    } as unknown as CallEdgeResolutionRunner;

    const finalizer = makeFinalizer(graphDb, runner);
    await expect(finalizer.resolveAndUpsert(writeSpill(["a.ts", "b.ts"]))).rejects.toThrow(/resolver exploded/);

    // a.ts's dispatched write is not left dangling past the rethrow.
    expect(log).toEqual(["flush:a.ts"]);
  });

  it("flushes the final partial batch on drain", async () => {
    process.env.CODEGRAPH_BULK_FILES = "10";
    const written: string[] = [];
    const graphDb = {
      upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]) => {
        for (const e of entries) written.push(e.node.relPath);
      },
      checkpoint: async () => undefined,
    } as unknown as GraphDbClient;

    const finalizer = makeFinalizer(graphDb, recordingRunner([]));
    await finalizer.resolveAndUpsert(writeSpill(["a.ts", "b.ts", "c.ts"]));

    expect(written).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("records only the AWAITED portion of a flush in the phase telemetry", async () => {
    // Rule-2 rewrite (`.claude/rules/test-invariants.md`, bd tea-rags-mcp-lffhl).
    // This test used to drive a real `setTimeout(40)` write against a 40ms
    // busy-wait resolve and assert `flush.ms < WRITE_MS * 2` — a RATIO of two
    // measured wall clocks, i.e. implementation timing rather than the
    // invariant. Under load (ten worktrees running suites at once) the timer
    // fired late relative to the busy-wait, the loop awaited a still-pending
    // write, and it failed with 94 < 80; green on re-run.
    //
    // The invariant is arithmetic, so it is asserted as arithmetic. A bulk
    // write takes `writeMs` of wall clock from the moment it is handed to the
    // session; resolving one file burns `resolveMs`. The loop dispatches the
    // write and keeps resolving, so the only thing it may charge to `flush` is
    // what is LEFT of that write when it finally parks on it —
    // `max(0, writeMs - resolveMs)` — never the portion that ran off-thread.
    // No real timers, no busy-wait: a manual clock and a write this test
    // settles by hand.
    const WRITE_MS = 40;

    async function runPass(relPaths: string[], resolveMs: number, writeMs: number): Promise<CodegraphPhaseTotal> {
      let t = 0;
      const timings = new CodegraphPhaseTimings(() => t);
      const lastRelPath = relPaths[relPaths.length - 1];
      // At most one write is ever open (the in-flight invariant pinned by the
      // tests above), so this is a one-slot mailbox, not a queue.
      const inFlight: { settlesAtMs: number; release: () => void }[] = [];
      const graphDb = {
        upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]): Promise<void> => {
          // The drain's final write has no resolve work left to hide it, so it
          // is handed over already landed. Left pending it would legitimately
          // cost the loop the whole `writeMs`, and the totals below would be
          // measuring the drain instead of the overlap.
          if (entries[0]?.node.relPath === lastRelPath) return Promise.resolve();
          return new Promise<void>((release) => {
            inFlight.push({ settlesAtMs: t + writeMs, release });
          });
        },
        checkpoint: async () => undefined,
      } as unknown as GraphDbClient;

      const runner = recordingRunner([], () => {
        t += resolveMs;
        // `settleFlush` is reached SYNCHRONOUSLY from here (resolve -> buffer
        // -> dispatchFlush -> settleFlush -> `await open`), so a microtask
        // queued here runs exactly once the loop is parked on the in-flight
        // write, and never before it. That ordering is the only thing this
        // test depends on, and it holds without any real time passing.
        queueMicrotask(() => {
          const open = inFlight.shift();
          if (!open) return;
          // The write's wall clock ran while the resolver worked; whatever is
          // left of it at the park is the stall the loop actually pays.
          t = Math.max(t, open.settlesAtMs);
          open.release();
        });
      });

      await makeFinalizer(graphDb, runner, timings).resolveAndUpsert(writeSpill(relPaths));
      return timings.snapshot().phases.flush;
    }

    // Resolve fully covers the write: by the time the loop parks, the write's
    // clock has already run out, so the awaited portion is exactly ZERO.
    const covered = await runPass(["a.ts", "b.ts", "c.ts"], WRITE_MS, WRITE_MS);
    // One record per dispatched batch — the count contract is unchanged.
    expect(covered.count).toBe(3);
    expect(covered.ms).toBe(0);

    // Resolve covers only part of it: the loop pays the REMAINDER, exactly.
    // Inline-await telemetry — or timing the write where it is dispatched
    // instead of where it is awaited — reports the full WRITE_MS here.
    const PARTIAL_RESOLVE_MS = 15;
    const partlyCovered = await runPass(["a.ts", "b.ts"], PARTIAL_RESOLVE_MS, WRITE_MS);
    expect(partlyCovered.count).toBe(2);
    expect(partlyCovered.ms).toBe(25); // 40 - 15, and never the full 40
  });
});

/** Poll until `pred` holds, yielding to the event loop between checks. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}
