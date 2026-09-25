import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { JavascriptCallResolver } from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-dy852 — `handleDeletedPaths` is the one graph mutation that
 * left the derived tables as the last finalize wrote them. It now prunes them
 * cheaply (cycles touching a deleted file, that file's ranks) and marks them
 * stale; the full recompute rides the next run that reaches this provider's
 * finalize — including `runFinalizeOnly`, whose finalize has no run sink.
 */
describe("CodegraphEnrichmentProvider — derived tables on deletion (dy852)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-prune-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(
        new Map([
          ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
          ["javascript", new JavascriptCallResolver()],
        ]),
      ),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A method + file cycle `src/a.ts#A.x ↔ src/b.ts#B.y`, recomputed by the sink. */
  async function seedCycle(): Promise<void> {
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }],
        methodEdges: [
          { sourceSymbolId: "A.x", targetSymbolId: "B.y", targetRelPath: "src/b.ts", callExpression: "y()" },
        ],
      },
    );
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }],
        methodEdges: [
          { sourceSymbolId: "B.y", targetSymbolId: "A.x", targetRelPath: "src/a.ts", callExpression: "x()" },
        ],
      },
    );
    await provider.asExtractionSink().finish();
  }

  it("prunes the cycles of a deleted file and marks the derived tables stale", async () => {
    await seedCycle();
    expect(await client.findCycles("method")).toHaveLength(1);
    expect(await provider.hasStaleDerivedState()).toBe(false);

    await provider.handleDeletedPaths(["src/a.ts"]);

    expect(await client.findCycles("method")).toEqual([]);
    expect(await client.findCycles("file")).toEqual([]);
    expect(await client.getPageRank("A.x", "src/a.ts")).toBe(0);
    expect(await provider.hasStaleDerivedState()).toBe(true);
  });

  it("a finalize with no run sink recomputes stale derived tables and clears the mark", async () => {
    await seedCycle();
    await provider.handleDeletedPaths(["src/a.ts"]);
    const replacePageRanks = vi.spyOn(client, "replacePageRanks");

    await provider.finalizeSignals("/repo");

    expect(replacePageRanks).toHaveBeenCalledTimes(1);
    expect(await provider.hasStaleDerivedState()).toBe(false);
  });

  it("a finalize with no run sink skips the recompute when nothing is stale", async () => {
    await seedCycle();
    const replacePageRanks = vi.spyOn(client, "replacePageRanks");

    await provider.finalizeSignals("/repo");

    expect(replacePageRanks).not.toHaveBeenCalled();
  });
});
