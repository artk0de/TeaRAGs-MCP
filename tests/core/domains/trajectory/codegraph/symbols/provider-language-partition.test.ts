/**
 * The provider half of per-language codegraph affinity (bd tea-rags-mcp-sgo8v).
 *
 * Under language affinity one collection is served by several provider
 * instances — one per language partition, each on its own worker. Every
 * partition absorbs EVERY file of the run, in the same order, so its symbol
 * table and run-global maps are the ones a single worker would have built; it
 * takes OWNERSHIP only of its own partition's files. Two things are pinned here:
 *
 *  - a `mirror` record feeds the partition's pass-1 state and nothing else — no
 *    node write, no spill line, no pass-2, no overlay, no count;
 *  - the finalize split into `resolve` (pass-2 of the owned files) and
 *    `readBack` (collection metrics on the one owner, then owned overlays)
 *    leaves the graph exactly as the one-call finalize does.
 *
 * That the partitions TOGETHER reproduce the single-worker graph is the
 * executor-level parity test (`language-affinity-parity.test.ts`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dumpCodegraphTables } from "../__helpers__/graph-db-dump.js";
import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { writeMixedLanguageCorpus } from "../__helpers__/mixed-language-corpus.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtractionAbsorbRole } from "../../../../../../src/core/contracts/types/provider.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

interface Harness {
  client: DuckDbGraphClient;
  dir: string;
}

async function openGraph(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "cg-partition-db-"));
  const client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
  await client.init();
  await runMigrations(client, MIG_DIR);
  return { client, dir };
}

function providerOn(client: DuckDbGraphClient): CodegraphEnrichmentProvider {
  return new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
}

const isTypeScript = (relPath: string): boolean => relPath.endsWith(".ts");

describe("CodegraphEnrichmentProvider — language partition roles", () => {
  let graph: Harness;
  let root: string;
  let corpus: string[];

  beforeEach(async () => {
    graph = await openGraph();
    root = mkdtempSync(join(tmpdir(), "cg-partition-repo-"));
    corpus = writeMixedLanguageCorpus(root);
  });

  afterEach(async () => {
    await graph.client.close();
    rmSync(graph.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("writes, resolves and reports only the files it owns; mirrors feed its state alone", async () => {
    const provider = providerOn(graph.client);
    const batch = await provider.extractFileBatch(root, corpus);
    const absorbRoles: FileExtractionAbsorbRole[] = batch.extractions.map((e) =>
      isTypeScript(e.relPath) ? "own" : "mirror",
    );
    expect(absorbRoles).toContain("mirror");

    await provider.absorbExtractedFiles(root, batch.extractions, { absorbRoles });
    await provider.finalizeSignals(root, { finalizeStage: "resolve", ownsCollectionCompletion: true });
    const overlays = await provider.finalizeSignals(root, {
      finalizeStage: "readBack",
      ownsCollectionCompletion: true,
    });

    const owned = batch.extractions.map((e) => e.relPath).filter(isTypeScript);
    const persisted = new Set((await graph.client.listAllSymbols()).map((s) => s.relPath));
    expect([...persisted].sort()).toEqual([...owned].sort());
    expect([...overlays.keys()].sort()).toEqual([...owned].sort());
    const files = (await graph.client.listFileContentHashes()).map((f) => f.relPath).sort();
    expect(files).toEqual([...owned].sort());
    expect(provider.getRunMetrics()?.extractedFiles).toBe(owned.length);
  });

  it("a mirrored file's symbols are visible to the owned files' resolution", async () => {
    // `web/main.ts` calls `create()` bare. TypeScript declares one and Ruby
    // declares another; the global short-name fallback is language-blind, so
    // whether the call resolves depends on whether Ruby's `create` is in the
    // table — which, for a TypeScript partition, only a mirror can put there.
    const withMirror = providerOn(graph.client);
    const batch = await withMirror.extractFileBatch(root, corpus);
    const absorbRoles: FileExtractionAbsorbRole[] = batch.extractions.map((e) =>
      isTypeScript(e.relPath) ? "own" : "mirror",
    );
    await withMirror.absorbExtractedFiles(root, batch.extractions, { absorbRoles });
    await withMirror.finalizeSignals(root, { finalizeStage: "resolve", ownsCollectionCompletion: true });
    await withMirror.finalizeSignals(root, { finalizeStage: "readBack", ownsCollectionCompletion: true });
    const mirrored = await dumpCodegraphTables(graph.client);

    const ownOnly = await openGraph();
    try {
      const alone = providerOn(ownOnly.client);
      const tsOnly = batch.extractions.filter((e) => isTypeScript(e.relPath));
      await alone.absorbExtractedFiles(root, tsOnly);
      await alone.finalizeSignals(root, { finalizeStage: "resolve", ownsCollectionCompletion: true });
      await alone.finalizeSignals(root, { finalizeStage: "readBack", ownsCollectionCompletion: true });
      const isolated = await dumpCodegraphTables(ownOnly.client);

      // Same owned files, different graph: the mirror is load-bearing.
      expect(mirrored.cg_symbols).toEqual(isolated.cg_symbols);
      expect(mirrored.cg_symbols_edges_method).not.toEqual(isolated.cg_symbols_edges_method);
    } finally {
      await ownOnly.client.close();
      rmSync(ownOnly.dir, { recursive: true, force: true });
    }
  });
});

describe("CodegraphEnrichmentProvider — staged finalize", () => {
  let staged: Harness;
  let single: Harness;
  let root: string;
  let corpus: string[];

  beforeEach(async () => {
    staged = await openGraph();
    single = await openGraph();
    root = mkdtempSync(join(tmpdir(), "cg-staged-repo-"));
    corpus = writeMixedLanguageCorpus(root);
  });

  afterEach(async () => {
    await staged.client.close();
    await single.client.close();
    rmSync(staged.dir, { recursive: true, force: true });
    rmSync(single.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("resolve then readBack leaves the graph and overlays the one-call finalize leaves", async () => {
    const one = providerOn(single.client);
    const oneBatch = await one.extractFileBatch(root, corpus);
    await one.absorbExtractedFiles(root, oneBatch.extractions);
    const oneOverlays = await one.finalizeSignals(root);

    const two = providerOn(staged.client);
    const twoBatch = await two.extractFileBatch(root, corpus);
    await two.absorbExtractedFiles(root, twoBatch.extractions);
    const resolved = await two.finalizeSignals(root, { finalizeStage: "resolve", ownsCollectionCompletion: true });
    const twoOverlays = await two.finalizeSignals(root, {
      finalizeStage: "readBack",
      ownsCollectionCompletion: true,
    });

    // Overlays need the whole graph, which only exists once every partition has
    // resolved — so the resolve stage reports none.
    expect(resolved.size).toBe(0);
    expect(twoOverlays).toEqual(oneOverlays);
    const stagedDump = await dumpCodegraphTables(staged.client);
    expect(stagedDump).toEqual(await dumpCodegraphTables(single.client));
    // The corpus is built to have both, so the equality above is not vacuous.
    expect(stagedDump.cg_symbols_cycles.length).toBeGreaterThan(0);
    expect(stagedDump.cg_symbols_metrics.length).toBeGreaterThan(0);
  });

  it("only the partition that owns collection completion recomputes cycles and PageRank", async () => {
    const provider = providerOn(staged.client);
    const batch = await provider.extractFileBatch(root, corpus);
    await provider.absorbExtractedFiles(root, batch.extractions);
    await provider.finalizeSignals(root, { finalizeStage: "resolve", ownsCollectionCompletion: false });
    await provider.finalizeSignals(root, { finalizeStage: "readBack", ownsCollectionCompletion: false });

    const dump = await dumpCodegraphTables(staged.client);
    expect(dump.cg_symbols_edges_method.length).toBeGreaterThan(0);
    expect(dump.cg_symbols_cycles).toEqual([]);
    expect(dump.cg_symbols_metrics).toEqual([]);
  });
});
