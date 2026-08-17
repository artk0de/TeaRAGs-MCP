/**
 * The pass-1 → pass-2 node-drain barrier (bd pass1-fanout, second pass).
 *
 * `finish()` used to await the WHOLE `cg_symbols` flush chain before pass-2
 * started. Once the extraction fan-out cut pass-1 in half on taxdome, that wait
 * stopped being hidden behind the parse: 24.1s of back-to-back
 * `CODEGRAPH_NODES_FLUSH` calls sat between the last extraction and the first
 * `PASS2_PROGRESS`, and the Ruby codegraph window regressed 51.9s → 59.9s even
 * though pass-1 itself went 18.8s → 9.1s.
 *
 * Nothing in pass-2 reads `cg_symbols` — it resolves against the in-memory
 * symbol table and writes only the edge / file / inheritance / fan-out tables,
 * and the schema declares no foreign keys (migration 001 says so explicitly).
 * So the drain is dispatched and pass-2 runs against it, with the chain settled
 * before `recomputeMetrics` and again in the `finally`.
 *
 * These specs pin the ORDER, which is the whole of the observable change.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BulkSymbolUpsertEntry,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  createCodegraphExtractionSink,
  type CodegraphSinkDeps,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/extraction-sink.js";
import { SymbolNodeFlushQueue } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/node-flush.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const extraction = (relPath: string): FileExtraction => ({
  relPath,
  language: "typescript",
  imports: [],
  chunks: [],
  fileScope: [],
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every already-queued macrotask run, so "did not get there" is a fact. */
async function settleTicks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((res) => {
      setImmediate(res);
    });
  }
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => {
      rej(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe("codegraph node-drain / pass-2 overlap", () => {
  let tmp: string;
  let log: string[];
  let gate: Deferred;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "node-drain-overlap-"));
    log = [];
    gate = deferred();
  });

  afterEach(() => {
    // Never leave a gated flush pending — a failed assertion must not strand
    // the chain and take the next spec's event loop with it.
    gate.resolve();
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** A real flush queue whose one write is held open by `gate`. */
  function makeQueue(onFlush?: (entries: BulkSymbolUpsertEntry[]) => void): SymbolNodeFlushQueue {
    return new SymbolNodeFlushQueue(
      async () => ({
        graphDb: {
          upsertSymbolsBulk: async (entries: BulkSymbolUpsertEntry[]) => {
            log.push("flush:start");
            await gate.promise;
            onFlush?.(entries);
            log.push("flush:end");
          },
        } as unknown as GraphDbClient,
      }),
      // Cadence high enough that `write` never auto-flushes: the drain under
      // test is the one `finish()` dispatches.
      1000,
    );
  }

  function makeDeps(nodeFlush: SymbolNodeFlushQueue, overrides: Partial<CodegraphSinkDeps> = {}): CodegraphSinkDeps {
    return {
      resolveSymbolTable: async () => ({ upsertFile: vi.fn() }) as unknown as GlobalSymbolTable,
      runState: new CodegraphRunState(),
      nodeFlush,
      buildSymbolDefs: () => [{ relPath: "src/a.ts", symbolId: "A#m", fqName: "A#m", shortName: "m", scope: [] }],
      indexChunkSymbolsByLine: () => undefined,
      collectionKey: (c) => c ?? "__direct__",
      spillPathFor: (_c, runId) => join(tmp, `${runId}.ndjson`),
      resolveAndUpsert: async () => {
        log.push("resolve:start");
        // Opening the gate from INSIDE pass-2 is the proof: the drain can only
        // finish once pass-2 is already running, so a chain that still blocks
        // pass-2 deadlocks instead of quietly passing.
        gate.resolve();
        log.push("resolve:end");
      },
      recomputeMetrics: async () => {
        log.push("metrics");
      },
      ...overrides,
    };
  }

  it("runs pass-2 while the node chain is still draining, and settles it before recomputeMetrics", async () => {
    const queue = makeQueue();
    const sink = createCodegraphExtractionSink(makeDeps(queue), "run-overlap");
    await sink.write(extraction("src/a.ts"));

    await withTimeout(sink.finish(), 2000);

    expect(log).toEqual(["flush:start", "resolve:start", "resolve:end", "flush:end", "metrics"]);
  });

  it("CODEGRAPH_NODE_DRAIN_OVERLAP=0 restores the blocking barrier — pass-2 waits for the whole chain", async () => {
    vi.stubEnv("CODEGRAPH_NODE_DRAIN_OVERLAP", "0");
    const queue = makeQueue();
    const sink = createCodegraphExtractionSink(makeDeps(queue), "run-barrier");
    await sink.write(extraction("src/a.ts"));

    const finished = sink.finish();
    await settleTicks();
    // Blocked on the gate INSIDE the drain: pass-2 has not been entered.
    expect(log).toEqual(["flush:start"]);

    gate.resolve();
    await withTimeout(finished, 2000);
    expect(log).toEqual(["flush:start", "flush:end", "resolve:start", "resolve:end", "metrics"]);
  });

  it("a latched node-flush error still aborts finish(), now after pass-2 has run", async () => {
    const failure = new Error("duckdb write denied");
    const queue = new SymbolNodeFlushQueue(
      async () => ({
        graphDb: {
          upsertSymbolsBulk: async () => {
            log.push("flush:start");
            throw failure;
          },
        } as unknown as GraphDbClient,
      }),
      1000,
    );
    const sink = createCodegraphExtractionSink(makeDeps(queue), "run-latched");
    await sink.write(extraction("src/a.ts"));

    await expect(sink.finish()).rejects.toBe(failure);
    // Pass-2 ran; metrics did NOT — the settle sits between them.
    expect(log).toEqual(["flush:start", "resolve:start", "resolve:end"]);
  });

  it("a pass-2 failure surfaces as the run's error, with the node chain settled first", async () => {
    const resolveFailure = new Error("pass-2 resolve blew up");
    const queue = makeQueue();
    const deps = makeDeps(queue, {
      resolveAndUpsert: async () => {
        log.push("resolve:start");
        gate.resolve();
        throw resolveFailure;
      },
    });
    const sink = createCodegraphExtractionSink(deps, "run-resolve-fails");
    await sink.write(extraction("src/a.ts"));

    await expect(withTimeout(sink.finish(), 2000)).rejects.toBe(resolveFailure);
    // The dispatched write landed before the error propagated — the run never
    // tears down with a `cg_symbols` transaction still open.
    expect(log).toContain("flush:end");
    expect(log).not.toContain("metrics");
  });
});
