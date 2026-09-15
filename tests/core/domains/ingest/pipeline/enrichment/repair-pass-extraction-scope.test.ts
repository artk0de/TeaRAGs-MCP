/**
 * The repair pass may only ask a provider for files that provider can actually
 * persist a row for (bd tea-rags-mcp-65bkl).
 *
 * `runRepairPass` used to take `shouldEnrich` as its definition of "eligible".
 * For codegraph that answer is wider than the walk: `shouldEnrich` declines only
 * generated files and the exclusion filter, so a `tsconfig.json` or a `README.md`
 * comes back `"full"` — but `streamFileBatchInner` drops it again for having no
 * `CODEGRAPH_LANGUAGES` entry, no extraction reaches the spill, and pass-2 never
 * writes its `cg_symbols_files` row. The hash diff then reports it missing on
 * EVERY subsequent run: measured `repaired=482` in perpetuity on taxdome, and a
 * `REPAIR_PASS` line on a repository where nothing changed.
 *
 * These run the real provider against a real DuckDB so the convergence claim is
 * end-to-end: what pass-1 walks is what pass-2 persists is what the next run's
 * diff reads back.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphDbClientPool } from "../../../../../../src/core/adapters/duckdb/pool.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { createDatabaseMigrationApplier } from "../../../../../../src/core/domains/maintenance/migration/database/index.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { buildTestCodegraphDeps } from "../../../trajectory/codegraph/__helpers__/language-factory.js";

const COLLECTION = "code_repair_scope_v1";

describe("repair pass — files the walker can never produce a row for", () => {
  let tmp: string;
  let repo: string;
  let pool: GraphDbClientPool;
  let provider: CodegraphEnrichmentProvider;
  let coordinator: EnrichmentCoordinator;
  /** Every path set the repair handed the executor, in call order. */
  let dispatched: string[][];

  /** Two walked languages plus two files no `CODEGRAPH_LANGUAGES` entry covers. */
  const scanned = new Map([
    ["src/a.ts", "ts-1"],
    ["lib/b.rb", "rb-1"],
    ["tsconfig.json", "json-1"],
    ["README.md", "md-1"],
  ]);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-repair-scope-"));
    repo = mkdtempSync(join(tmpdir(), "cg-repair-scope-repo-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export function a(): number {\n  return 1;\n}\n");
    writeFileSync(join(repo, "lib", "b.rb"), "class B\n  def call\n    1\n  end\nend\n");
    writeFileSync(join(repo, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }\n');
    writeFileSync(join(repo, "README.md"), "# demo\n\nnothing to walk here.\n");

    pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });
    provider = new CodegraphEnrichmentProvider({
      pool,
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });

    dispatched = [];
    coordinator = new EnrichmentCoordinator({} as never, provider, undefined, {
      runFileBatch: vi.fn(
        async (
          p: CodegraphEnrichmentProvider,
          root: string,
          paths: string[],
          options: { collectionName?: string; contentHashes?: ReadonlyMap<string, string> },
        ) => {
          dispatched.push([...paths].sort());
          return p.streamFileBatch(root, paths, options);
        },
      ),
      runFileSignalsStreaming: vi.fn().mockResolvedValue(new Map()),
      runChunkSignals: vi.fn().mockResolvedValue(new Map()),
      runFinalize: vi.fn().mockResolvedValue(new Map()),
      releaseRun: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(async () => {
    await pool.closeAll();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  /** Repair + the pass-2 that actually writes the `cg_symbols_files` rows. */
  async function repairAndPersist(hashes: ReadonlyMap<string, string>): Promise<number> {
    const repaired = await coordinator.runRepairPass(COLLECTION, repo, hashes);
    await provider.finalizeSignals(repo, { collectionName: COLLECTION, contentHashes: hashes });
    return repaired;
  }

  it("never asks for a file whose extension no walker covers", async () => {
    await repairAndPersist(scanned);

    // The fresh-collection case: everything the walk CAN persist, and nothing
    // else. Handing it `tsconfig.json` costs a dispatch that can only no-op.
    expect(dispatched).toEqual([["lib/b.rb", "src/a.ts"]]);
  });

  it("converges — a second run over unchanged files repairs nothing", async () => {
    await repairAndPersist(scanned);
    dispatched = [];

    const repaired = await repairAndPersist(scanned);

    // The whole point: an untouched repository must produce no REPAIR_PASS at
    // all. Before the fix this stayed at 2 (tsconfig.json + README.md) forever,
    // because neither can ever acquire the row the diff looks for.
    expect(repaired).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("still repairs a supported file that genuinely drifted", async () => {
    await repairAndPersist(scanned);
    dispatched = [];

    const drifted = new Map(scanned).set("lib/b.rb", "rb-2");
    const repaired = await repairAndPersist(drifted);

    // Control: narrowing the eligible set must not blunt the check it narrows.
    expect(repaired).toBe(1);
    expect(dispatched).toEqual([["lib/b.rb"]]);
  });

  it("keeps a row it cannot re-derive out of the orphan prune", async () => {
    await repairAndPersist(scanned);

    // Narrowing `eligible` widens `orphans` by construction, so the rows the
    // walk DOES own must survive it — a prune here would delete the graph on
    // every quiet run instead of merely re-listing it.
    const persisted = await provider.readPersistedFileHashes(COLLECTION);
    expect([...persisted.keys()].sort()).toEqual(["lib/b.rb", "src/a.ts"]);

    await repairAndPersist(scanned);

    expect([...(await provider.readPersistedFileHashes(COLLECTION)).keys()].sort()).toEqual(["lib/b.rb", "src/a.ts"]);
  });
});
