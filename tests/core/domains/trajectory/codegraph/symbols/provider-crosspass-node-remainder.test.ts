/**
 * Cross-pass MAIN-instance node-buffer remainder flush (correctness).
 *
 * PRODUCTION cross-pass (`--force`) runs the codegraph provider across TWO
 * distinct instances (see `bootstrap/factory.ts` worker-pool executor):
 *   - the MAIN (composition-root) instance receives `beginExtractionRun` +
 *     `acceptExtraction` per file — it buffers each file's durable symbol defs
 *     in `nodeDefBuffer` and flushes only COMPLETE `CODEGRAPH_NODE_FLUSH_FILES`
 *     batches during embedding overlap;
 *   - the WORKER instance runs `finalizeSignals(crossPass)` — it drains the
 *     MAIN-written input spill, resolves edges (pass-2), and its OWN (empty)
 *     `nodeDefBuffer` remainder flush is a no-op.
 *
 * The two instances share nothing in-heap — only the on-disk graph DB and the
 * input spill. So the `N mod CODEGRAPH_NODE_FLUSH_FILES` files left buffered on
 * the MAIN instance after the file phase are flushed by NOBODY: the WORKER's
 * `flushNodeRemainder` splices the WORKER's empty buffer, and the next run's
 * `beginExtractionRun → clearRunState` discards the MAIN remainder unwritten.
 * Result: up to `CODEGRAPH_NODE_FLUSH_FILES - 1` files' `cg_symbols` nodes are
 * never durably written, yet pass-2 (resolving off the in-memory table the
 * worker rebuilt from the spill) still writes their edges — dangling edges /
 * missing `get_callers` targets.
 *
 * The existing single-instance tests (`provider-eager-flush.test.ts`) cannot
 * see this: there `acceptExtraction` and `finalizeSignals` run on the SAME
 * instance, so its `finalizeSignals → drainInputSpill → flushNodeRemainder`
 * flushes the remainder that `acceptExtraction` buffered. Only the real
 * MAIN↔WORKER boundary loses it.
 *
 * Invariant under test: after the MAIN-instance end-of-file-phase flush
 * (`endExtractionRun`, mirror of `beginExtractionRun`, awaited before the
 * WORKER's `finalizeSignals` dispatch), EVERY accepted file's node is durable —
 * regardless of whether the file count is a multiple of the flush cadence.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

function mkExtraction(relPath: string, klass: string, method: string): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [klass],
    chunks: [{ symbolId: `${klass}#${method}`, scope: [klass], calls: [], startLine: 1, endLine: 3 }],
  };
}

const EXTRACTIONS: readonly FileExtraction[] = [
  mkExtraction("a_alpha.rb", "Alpha", "one"),
  mkExtraction("b_beta.rb", "Beta", "two"),
  mkExtraction("c_gamma.rb", "Gamma", "three"),
  mkExtraction("d_delta.rb", "Delta", "four"),
  mkExtraction("e_epsilon.rb", "Epsilon", "five"),
  mkExtraction("f_zeta.rb", "Zeta", "six"),
];

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.CODEGRAPH_NODE_FLUSH_FILES;
});

/**
 * Drive the PRODUCTION two-instance cross-pass split against one shared graph
 * DB: the MAIN instance accepts every extraction (buffer + eager batch flush),
 * runs the new end-of-file-phase remainder flush, then a SEPARATE WORKER
 * instance drains the spill + finalizes. Returns the durably-written relPaths.
 */
async function runTwoInstanceCrossPass(
  extractions: readonly FileExtraction[],
  opts: { flushFiles: number },
): Promise<string[]> {
  // Read once at construction — set BEFORE either `new CodegraphEnrichmentProvider`.
  process.env.CODEGRAPH_NODE_FLUSH_FILES = String(opts.flushFiles);
  const collectionName = `xpass_remainder_${randomUUID().replace(/-/g, "")}`;
  const paths = extractions.map((e) => e.relPath);

  const tmp = mkdtempSync(join(tmpdir(), "cg-xpass-remainder-"));
  const graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
  await graphDb.init();
  await runMigrations(graphDb, MIG_DIR);

  // Two provider instances share the on-disk graph DB + input spill (keyed by
  // collectionName), nothing in-heap — the real MAIN↔WORKER production split.
  const mainProvider = new CodegraphEnrichmentProvider({
    graphDb,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
  const workerProvider = new CodegraphEnrichmentProvider({
    graphDb,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });

  cleanups.push(async () => {
    await graphDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // MAIN thread: run start + per-file accept (tee to spill + node buffer).
  mainProvider.beginExtractionRun(collectionName);
  for (const e of extractions) mainProvider.acceptExtraction(e, { collectionName });
  // MAIN thread: end-of-file-phase remainder flush — the seam under test. Awaited
  // before the WORKER's finalize dispatch (nodes-before-edges across instances).
  await mainProvider.endExtractionRun(collectionName);

  // WORKER thread: drain the MAIN-written spill + resolve edges. Its own node
  // buffer is empty; it must NOT re-run beginExtractionRun (that truncates the
  // spill). This mirrors the coordinator dispatching runFinalize to the worker.
  await workerProvider.finalizeSignals(tmp, { crossPass: true, paths, collectionName });

  const rows = await graphDb.listAllSymbols();
  return rows.map((r) => r.relPath).sort();
}

describe("CodegraphEnrichmentProvider — cross-pass MAIN-instance node remainder flush", () => {
  it("flushes ALL accepted files when the file count is below the flush cadence (whole run is remainder)", async () => {
    // flushFiles > file count ⇒ NOTHING flushes eagerly; all 6 files sit in the
    // MAIN buffer. Pre-fix the WORKER finalize never flushes them → 0 nodes.
    const written = await runTwoInstanceCrossPass(EXTRACTIONS, { flushFiles: 1000 });
    expect(written).toEqual([...EXTRACTIONS].map((e) => e.relPath).sort());
  });

  it("flushes the sub-cadence remainder on top of the eagerly-flushed full batches", async () => {
    // flushFiles 4, 6 files → one eager batch of 4 during accept, remainder 2.
    // Pre-fix the 2 remainder files are lost across the MAIN↔WORKER boundary.
    const written = await runTwoInstanceCrossPass(EXTRACTIONS, { flushFiles: 4 });
    expect(written).toEqual([...EXTRACTIONS].map((e) => e.relPath).sort());
  });
});
