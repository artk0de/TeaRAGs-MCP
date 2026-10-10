/**
 * The DuckDB stores behind `DuckDbGraphClient` answer the codegraph storage
 * sub-interfaces of `GraphDbClient` (bd tea-rags-mcp-0qaht.38). Each store is
 * typed against the slice of a sub-interface it owns; the three composites
 * (`DuckDbSymbolFileStore`, `DuckDbStorageMaintenance`,
 * `DuckDbTemporalStoreFacade`) answer a whole sub-interface. The `satisfies`
 * clauses are the type-level pin (`tsc -p tsconfig.tests.json`); the runtime
 * assertions pin that the composites work over a real session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DuckDbFileGraphStore } from "../../../../src/core/adapters/duckdb/file-graph-store.js";
import { DuckDbFileMetricsReader } from "../../../../src/core/adapters/duckdb/file-metrics-reader.js";
import { DuckDbGraphAnalyticsStore } from "../../../../src/core/adapters/duckdb/graph-analytics-store.js";
import { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";
import { DuckDbHierarchyReader } from "../../../../src/core/adapters/duckdb/hierarchy-reader.js";
import { DuckDbIdentifierStore } from "../../../../src/core/adapters/duckdb/identifier-store.js";
import { DuckDbMethodEdgeReader } from "../../../../src/core/adapters/duckdb/method-edge-reader.js";
import { DuckDbOntologyReportStore } from "../../../../src/core/adapters/duckdb/ontology-report-store.js";
import { DuckDbRunStatsStore } from "../../../../src/core/adapters/duckdb/run-stats-store.js";
import { DuckDbSignalDriftStore } from "../../../../src/core/adapters/duckdb/signal-drift-store.js";
import { DuckDbStorageMaintenance } from "../../../../src/core/adapters/duckdb/storage-maintenance.js";
import { DuckDbSymbolFileStore } from "../../../../src/core/adapters/duckdb/symbol-file-store.js";
import { DuckDbSymbolStore } from "../../../../src/core/adapters/duckdb/symbol-store.js";
import { DuckDbTemporalCochangeStore } from "../../../../src/core/adapters/duckdb/temporal-cochange-store.js";
import { DuckDbTemporalStoreFacade } from "../../../../src/core/adapters/duckdb/temporal-store-facade.js";
import { DuckDbTemporalSymbolCommitStore } from "../../../../src/core/adapters/duckdb/temporal-symbol-commit-store.js";
import { DuckDbTypeNameStore } from "../../../../src/core/adapters/duckdb/type-name-store.js";
import type {
  CodegraphGraphAnalyticsStore,
  CodegraphGraphReadStore,
  CodegraphIdentifierStore,
  CodegraphOntologyReportStore,
  CodegraphStorageMaintenance,
  CodegraphSymbolFileStore,
  CodegraphTemporalStore,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function freshSession(): Promise<DuckDbGraphSession> {
  const dir = mkdtempSync(join(tmpdir(), "cg-store-ifaces-"));
  const session = new DuckDbGraphSession({ path: join(dir, "g.duckdb") });
  await session.open();
  await runMigrations(session, DATABASE_MIGRATIONS);
  cleanups.push(async () => {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return session;
}

describe("DuckDB stores answer the codegraph storage sub-interfaces", () => {
  it("types every store against the sub-interface slice it owns", async () => {
    const session = await freshSession();
    const fileGraph = new DuckDbFileGraphStore(session);
    const symbols = new DuckDbSymbolStore(session);
    const runStats = new DuckDbRunStatsStore(session) satisfies Pick<
      CodegraphStorageMaintenance,
      "recordRunStats" | "recordFileResolveStats" | "getRunStats" | "getEdgeKindDistribution"
    >;

    const stores = {
      identifiers: new DuckDbIdentifierStore(session) satisfies Omit<
        CodegraphIdentifierStore,
        "replaceTypeDeclarationsBulk" | "readTypeNameRows"
      >,
      typeNames: new DuckDbTypeNameStore(session) satisfies Pick<
        CodegraphIdentifierStore,
        "replaceTypeDeclarationsBulk" | "readTypeNameRows"
      >,
      ontology: new DuckDbOntologyReportStore(session) satisfies CodegraphOntologyReportStore,
      fileMetrics: new DuckDbFileMetricsReader(session) satisfies Pick<
        CodegraphGraphReadStore,
        "getFanIn" | "getFanOut" | "getFanInP95" | "getTransitiveImpact" | "getFileMetricsBulk"
      >,
      methodEdges: new DuckDbMethodEdgeReader(session) satisfies Omit<
        CodegraphGraphReadStore,
        | "getFanIn"
        | "getFanOut"
        | "getFanInP95"
        | "getTransitiveImpact"
        | "getFileMetricsBulk"
        | "getSupertypes"
        | "getSubtypes"
        | "getTransitiveSubtypes"
        | "loadHierarchySnapshot"
      >,
      hierarchy: new DuckDbHierarchyReader(session) satisfies Pick<
        CodegraphGraphReadStore,
        "getSupertypes" | "getSubtypes" | "getTransitiveSubtypes" | "loadHierarchySnapshot"
      >,
      analytics: new DuckDbGraphAnalyticsStore(session) satisfies Omit<
        CodegraphGraphAnalyticsStore,
        "diffSymbolSignals" | "refreshSymbolSignalsPrev" | "computeAndPersistCyclesAndSignals"
      >,
      signalDrift: new DuckDbSignalDriftStore(session) satisfies Pick<
        CodegraphGraphAnalyticsStore,
        "diffSymbolSignals" | "refreshSymbolSignalsPrev"
      >,
      temporal: new DuckDbTemporalStoreFacade(
        new DuckDbTemporalCochangeStore(session),
        new DuckDbTemporalSymbolCommitStore(session),
      ) satisfies CodegraphTemporalStore,
      symbolFiles: new DuckDbSymbolFileStore(session, fileGraph, symbols) satisfies CodegraphSymbolFileStore,
      maintenance: new DuckDbStorageMaintenance(session, fileGraph, runStats) satisfies CodegraphStorageMaintenance,
    };

    expect(Object.values(stores).every((store) => store !== undefined)).toBe(true);
  });

  it("DuckDbSymbolFileStore writes a file with its symbols and removes it again", async () => {
    const session = await freshSession();
    const fileGraph = new DuckDbFileGraphStore(session);
    const symbolFiles = new DuckDbSymbolFileStore(session, fileGraph, new DuckDbSymbolStore(session));
    const maintenance = new DuckDbStorageMaintenance(session, fileGraph, new DuckDbRunStatsStore(session));

    expect(await maintenance.hasData()).toBe(false);

    await symbolFiles.upsertFilesBulk([
      { node: { relPath: "app/a.rb", language: "ruby" }, edges: { fileEdges: [], methodEdges: [] } },
    ]);
    await symbolFiles.upsertFile(
      { relPath: "app/b.rb", language: "ruby" },
      { fileEdges: [{ targetRelPath: "app/a.rb", importText: "zeitwerk:A" }], methodEdges: [] },
    );
    await symbolFiles.upsertSymbols("app/b.rb", [
      { symbolId: "B#run", relPath: "app/b.rb", shortName: "run", fqName: "B#run", scope: ["B"] },
    ]);

    expect(await maintenance.hasData()).toBe(true);
    expect((await symbolFiles.listFileContentHashes()).map((r) => r.relPath).sort()).toEqual(["app/a.rb", "app/b.rb"]);
    expect((await symbolFiles.listAllSymbols()).map((s) => s.symbolId)).toEqual(["B#run"]);

    await symbolFiles.removeSymbolsForFile("app/b.rb");
    await symbolFiles.removeFiles(["app/a.rb", "app/b.rb"]);

    expect(await symbolFiles.listAllSymbols()).toEqual([]);
    expect(await maintenance.hasData()).toBe(false);
  });
});
