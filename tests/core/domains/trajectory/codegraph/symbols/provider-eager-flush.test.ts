/**
 * Task 2 — eager batched codegraph node upsert during embedding (cross-pass).
 *
 * The durable node write (`cg_symbols`) is hoisted out of the post-embedding
 * finalize tail: `acceptExtraction` buffers each file's symbol defs and, once
 * the per-collection buffer reaches `CODEGRAPH_NODE_FLUSH_FILES`, chains a
 * batched `graphDb.upsertSymbolsBulk` onto a serialized flush chain (fire-and-
 * chain, not awaited in the hot path). `drainInputSpill` final-flushes the
 * remainder, awaits the chain (where an eager-flush failure surfaces), then runs
 * its sorted drain with the durable node write SKIPPED — the in-memory symbol
 * table + line map + Half-B run-global merges still run in sorted order.
 *
 * Invariants under test:
 *   1. Graph-equality — a small flush cadence (eager) yields the SAME cg_symbols
 *      as a huge cadence (drain-remainder-only): the write is order-independent
 *      (last-wins per relPath).
 *   2. Durable write once per file, and the drain issues NO per-file
 *      `upsertSymbols` (it was hoisted to the bulk path).
 *   3. Determinism — two different accept orders yield equal run-global output
 *      (the order-dependent merges stay in the sorted drain, unmoved).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type {
  FileExtraction,
  InheritanceEdgeRow,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

/**
 * The provider's run-global maps, owned by `CodegraphRunState` since the G2
 * collaborator split (bd tea-rags-mcp-6vfrj). Same fields, same semantics — only
 * the object holding them moved, so this snapshot reads them at the new address.
 */
interface ProviderRunGlobals {
  runState: {
    ancestors: Record<string, readonly string[]>;
    returnTypes: Record<string, string>;
    inheritanceRows: InheritanceEdgeRow[];
  };
}

interface RunGlobalSnapshot {
  runAncestors: Record<string, readonly string[]>;
  runReturnTypes: Record<string, string>;
  runInheritanceRows: InheritanceEdgeRow[];
}

interface CrossPassResult {
  rows: SymbolDefinition[];
  runGlobalSnapshot: RunGlobalSnapshot;
  bulkFlushedRelPaths: string[];
  perFileUpsertCount: number;
}

function mkExtraction(
  relPath: string,
  klass: string,
  method: string,
  extra: Partial<FileExtraction> = {},
): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [klass],
    chunks: [{ symbolId: `${klass}#${method}`, scope: [klass], calls: [], startLine: 1, endLine: 3 }],
    ...extra,
  };
}

// Six files. Two of them (b_beta, e_epsilon) declare COLLIDING run-global keys
// (`build` return type + `Shared` ancestor) with different values — sorted drain
// makes the last-write-wins deterministic regardless of accept order, so the
// determinism assertion is non-trivial.
const EXTRACTIONS: readonly FileExtraction[] = [
  mkExtraction("a_alpha.rb", "Alpha", "one"),
  mkExtraction("b_beta.rb", "Beta", "two", {
    classAncestors: { Beta: ["Alpha"], Shared: ["BaseB"] },
    functionReturnTypes: { build: "Widget" },
  }),
  mkExtraction("c_gamma.rb", "Gamma", "three"),
  mkExtraction("d_delta.rb", "Delta", "four"),
  mkExtraction("e_epsilon.rb", "Epsilon", "five", {
    classAncestors: { Epsilon: ["Gamma"], Shared: ["BaseE"] },
    functionReturnTypes: { build: "Gadget" },
  }),
  mkExtraction("f_zeta.rb", "Zeta", "six"),
];

/** Deterministic seeded Fisher-Yates so two seeds give two stable orders. */
function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function bySymbol(a: SymbolDefinition, b: SymbolDefinition): number {
  const ka = `${a.relPath} ${a.symbolId}`;
  const kb = `${b.relPath} ${b.symbolId}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function snapshotRunGlobals(p: ProviderRunGlobals): RunGlobalSnapshot {
  return {
    runAncestors: structuredClone(p.runState.ancestors),
    runReturnTypes: structuredClone(p.runState.returnTypes),
    runInheritanceRows: structuredClone(p.runState.inheritanceRows),
  };
}

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.CODEGRAPH_NODE_FLUSH_FILES;
  vi.restoreAllMocks();
});

/**
 * Drive the cross-pass path against a fresh direct-mode provider: feed the
 * extractions through `acceptExtraction` (in the given order) at the given flush
 * cadence, then run the cross-pass finalize (drain + resolve). Returns the
 * persisted `cg_symbols`, a mid-finalize snapshot of the run-global maps, and
 * spy tallies for the durable node writes.
 */
async function runCrossPass(
  extractions: readonly FileExtraction[],
  opts: { flushFiles: number; bulkReject?: Error },
): Promise<CrossPassResult> {
  // Read once at construction — set BEFORE `new CodegraphEnrichmentProvider`.
  process.env.CODEGRAPH_NODE_FLUSH_FILES = String(opts.flushFiles);
  // Unique collection so the direct-mode input spill path never collides with a
  // sibling test file running in parallel under the shared cwd spill dir.
  const collectionName = `eager_${randomUUID().replace(/-/g, "")}`;
  const paths = extractions.map((e) => e.relPath);

  const tmp = mkdtempSync(join(tmpdir(), "cg-eager-"));
  const client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
  await client.init();
  await runMigrations(client, MIG_DIR);
  const symbolTable = new InMemoryGlobalSymbolTable();

  const bulkSpy = vi.spyOn(client, "upsertSymbolsBulk");
  const perFileSpy = vi.spyOn(client, "upsertSymbols");
  // Make the FIRST bulk flush (the eager one during accept) reject; later flushes
  // (the drain remainder) fall through to the real implementation.
  if (opts.bulkReject) {
    const boom = opts.bulkReject;
    bulkSpy.mockImplementationOnce(async () => {
      throw boom;
    });
  }

  const provider = new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable,
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });

  // Capture the run-global maps mid-finalize (recordRunStats runs after the
  // sorted drain merged them, before the finally-reset clears them).
  let runGlobalSnapshot: RunGlobalSnapshot | undefined;
  const realRecord = (Object.getPrototypeOf(provider) as { recordRunStats: (g: unknown) => Promise<void> })
    .recordRunStats;
  vi.spyOn(
    provider as unknown as { recordRunStats: (g: unknown) => Promise<void> },
    "recordRunStats",
  ).mockImplementation(async function (this: ProviderRunGlobals, g: unknown) {
    runGlobalSnapshot = snapshotRunGlobals(this);
    return realRecord.call(this, g);
  } as (g: unknown) => Promise<void>);

  cleanups.push(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  provider.beginExtractionRun(collectionName);
  for (const e of extractions) provider.acceptExtraction(e, { collectionName });
  if (opts.bulkReject) {
    // Reproduce the PRODUCTION accept→drain window: there, many macrotasks of
    // embedding work separate the eager flush from `drainInputSpill`. In this
    // unit test accept and drain are otherwise microtask-adjacent, so a rejected
    // fire-and-chain tail would get its handler attached before Node's
    // unhandled-rejection checkpoint runs — hiding the bug. One macrotask yield
    // opens the same window the real indexer has (Node's checkpoint fires, and on
    // an unlatched tail emits `unhandledRejection`).
    await new Promise((r) => setTimeout(r, 0));
  }
  await provider.streamFileBatch(tmp, paths, { crossPass: true, collectionName });
  await provider.finalizeSignals(tmp, { crossPass: true, paths, collectionName });

  const rows = (await client.listAllSymbols()).slice().sort(bySymbol);
  const bulkFlushedRelPaths = bulkSpy.mock.calls.flatMap((c) => c[0]).map((e) => e.relPath);
  const perFileUpsertCount = perFileSpy.mock.calls.length;

  if (!runGlobalSnapshot) throw new Error("recordRunStats was not invoked — snapshot missing");
  return { rows, runGlobalSnapshot, bulkFlushedRelPaths, perFileUpsertCount };
}

describe("CodegraphEnrichmentProvider — Task 2 eager batched node flush (cross-pass)", () => {
  it("eager and remainder flush cadences produce identical cg_symbols (bulk write is order-independent)", async () => {
    // BOTH arms route the durable write through the SAME accept-time
    // `upsertSymbolsBulk` buffer: at MAX cadence nothing flushes eagerly so every
    // file lands as the drain REMAINDER; at cadence 4 most files flush eagerly and
    // the rest as remainder. So this proves the batched write is order-independent
    // (last-wins per relPath), NOT equivalence to the pre-change per-file
    // `upsertSymbols` sorted-drain path — that equivalence is guarded by the
    // unchanged yl9tv `codegraph-extraction-bridge` business-logic test.
    const remainderOnly = await runCrossPass(EXTRACTIONS, { flushFiles: Number.MAX_SAFE_INTEGER });
    const eager = await runCrossPass(EXTRACTIONS, { flushFiles: 4 });
    expect(eager.rows).toEqual(remainderOnly.rows);
    // Sanity: the run actually persisted one row per file (chunk).
    expect(eager.rows.map((r) => r.relPath)).toEqual([...EXTRACTIONS].map((e) => e.relPath).sort());
  });

  it("durable node write happens exactly once per file, and the drain issues no per-file upsertSymbols", async () => {
    const { bulkFlushedRelPaths, perFileUpsertCount } = await runCrossPass(EXTRACTIONS, { flushFiles: 4 });
    // Every file flushed through the bulk path exactly once.
    expect(bulkFlushedRelPaths.slice().sort()).toEqual([...EXTRACTIONS].map((e) => e.relPath).sort());
    expect(new Set(bulkFlushedRelPaths).size).toBe(EXTRACTIONS.length);
    // The drain skipped the hoisted durable write.
    expect(perFileUpsertCount).toBe(0);
  });

  it("run-global merge order is unchanged across two different accept orders (determinism invariant)", async () => {
    const a = await runCrossPass(shuffle(EXTRACTIONS, 1), { flushFiles: 4 });
    const b = await runCrossPass(shuffle(EXTRACTIONS, 2), { flushFiles: 4 });
    expect(a.runGlobalSnapshot).toEqual(b.runGlobalSnapshot);
    // The colliding key resolves to the sorted-drain last writer regardless of
    // accept order (e_epsilon > b_beta), proving the merge is order-independent.
    expect(a.runGlobalSnapshot.runReturnTypes.build).toBe("Gadget");
    expect(a.runGlobalSnapshot.runAncestors.Shared).toEqual(["BaseE"]);
    // And the persisted cg_symbols match too (order-independent node write).
    expect(a.rows).toEqual(b.rows);
  });

  it("a rejecting eager flush aborts the run at the drain without an unhandled rejection", async () => {
    // An eager `upsertSymbolsBulk` rejection lands mid-embedding, MANY macrotasks
    // before `drainInputSpill` awaits the chain. Without the `.catch` latch the
    // rejected tail is unhandled in that window — and on Node >=22 with no
    // `unhandledRejection` handler that TERMINATES the process. Registering our
    // own listener both prevents that crash and lets us assert none fired: the
    // latch must keep every chain link resolved and rethrow only at the drain.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const boom = new Error("simulated bulk upsert failure");
      // flushFiles:4 with 6 files → an eager batch of 4 flushes during accept and
      // rejects; the run must still abort with that exact error at the drain.
      await expect(runCrossPass(EXTRACTIONS, { flushFiles: 4, bulkReject: boom })).rejects.toThrow(
        "simulated bulk upsert failure",
      );
      // Give any pending unhandled-rejection detection a macrotask to fire.
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("streams a >CHECKPOINT_EVERY file set through the batched flush + checkpoint cadence", async () => {
    // The pass-2 resolve/upsert loop buffers file writes and flushes them in
    // BULK_FILES (256) sub-batches, running a `graphDb.checkpoint()` every
    // CHECKPOINT_EVERY (500) files (plus a final flush + trailing checkpoint for
    // the remainder). A 550-file run crosses the 256 flush boundary twice, the
    // 500 checkpoint once, and leaves a sub-batch remainder — exercising the
    // whole cadence, not just the small-N single-flush path the other cases hit.
    const many = Array.from({ length: 550 }, (_, i) => {
      const id = String(i).padStart(4, "0");
      return mkExtraction(`f${id}.rb`, `K${id}`, `m${id}`);
    });
    const { rows } = await runCrossPass(many, { flushFiles: Number.MAX_SAFE_INTEGER });
    // Every file persisted exactly one symbol row across the whole cadence.
    expect(rows).toHaveLength(550);
    expect(new Set(rows.map((r) => r.relPath)).size).toBe(550);
  });
});
