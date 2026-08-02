/**
 * `CodegraphEnrichmentProvider.readPersistedFileHashes` (bd tea-rags-mcp-6goqa).
 *
 * The repair check needs to know what the graph currently believes about each
 * file before it can decide which files must be re-extracted. This is the read
 * half of that: rel_path → the content hash persisted with the row, with `null`
 * for rows written before the column existed.
 *
 * A collection with no graph yet must come back EMPTY rather than throw — that
 * is the fresh-`_vN` case, where the repair set is legitimately "every eligible
 * file".
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { GraphDbClientPool } from "../../../../../../src/core/adapters/duckdb/pool.js";
import type { GraphEdges } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { createDatabaseMigrationApplier } from "../../../../../../src/core/domains/maintenance/migration/database/index.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const NO_EDGES: GraphEdges = { fileEdges: [], methodEdges: [] };

describe("CodegraphEnrichmentProvider.readPersistedFileHashes", () => {
  let tmp: string;
  let pool: GraphDbClientPool;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-persisted-hashes-"));
    pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });
    provider = new CodegraphEnrichmentProvider({
      pool,
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await pool.closeAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports the hash persisted with each file, and null where none was written", async () => {
    const handle = await pool.acquire("code_demo_v1");
    await handle.graphDb.upsertFile({ relPath: "src/a.ts", language: "typescript", contentHash: "h1" }, NO_EDGES);
    await handle.graphDb.upsertFile({ relPath: "src/b.ts", language: "typescript" }, NO_EDGES);

    const hashes = await provider.readPersistedFileHashes("code_demo_v1");

    expect(hashes).toEqual(
      new Map([
        ["src/a.ts", "h1"],
        ["src/b.ts", null],
      ]),
    );
  });

  it("returns an empty map for a collection that has no graph yet", async () => {
    const hashes = await provider.readPersistedFileHashes("code_never_indexed");

    expect(hashes.size).toBe(0);
  });
});
