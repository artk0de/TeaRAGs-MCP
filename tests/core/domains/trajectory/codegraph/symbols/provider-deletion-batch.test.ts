import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-b4drg — `handleDeletedPaths` paid one store round trip pair
 * PER deleted path (`removeFile` + `removeSymbolsForFile`; 5432 daemon IPCs for
 * 2716 deleted taxdome files, 18.8 s). N deleted paths are now ONE set-based
 * `removeFiles` call, after the derived prune and the hierarchy invalidation.
 */
describe("CodegraphEnrichmentProvider — batched deletion (b4drg)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let symbolTable: InMemoryGlobalSymbolTable;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-batch-delete-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    symbolTable = new InMemoryGlobalSymbolTable();
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable,
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes N deleted paths with one store call, after the derived prune and hierarchy invalidation", async () => {
    const calls: string[] = [];
    const prune = vi.spyOn(client, "pruneDerivedForDeletedFiles").mockImplementation(async () => {
      calls.push("pruneDerivedForDeletedFiles");
    });
    const invalidate = vi.spyOn(client, "invalidateHierarchyDependentsOfDeletedFiles").mockImplementation(async () => {
      calls.push("invalidateHierarchyDependentsOfDeletedFiles");
    });
    const removeFiles = vi.spyOn(client, "removeFiles").mockImplementation(async () => {
      calls.push("removeFiles");
    });
    const removeFile = vi.spyOn(client, "removeFile");
    const removeSymbolsForFile = vi.spyOn(client, "removeSymbolsForFile");
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];

    await provider.handleDeletedPaths(paths);

    expect(removeFiles).toHaveBeenCalledTimes(1);
    expect(removeFiles).toHaveBeenCalledWith(paths);
    expect(removeFile).not.toHaveBeenCalled();
    expect(removeSymbolsForFile).not.toHaveBeenCalled();
    expect(prune).toHaveBeenCalledWith(paths);
    expect(invalidate).toHaveBeenCalledWith(paths);
    expect(calls).toEqual([
      "pruneDerivedForDeletedFiles",
      "invalidateHierarchyDependentsOfDeletedFiles",
      "removeFiles",
    ]);
  });

  it("still clears every deleted path from the in-memory symbol table", async () => {
    vi.spyOn(client, "removeFiles");
    const forget = vi.spyOn(symbolTable, "removeFile");

    await provider.handleDeletedPaths(["src/a.ts", "src/b.ts"]);

    expect(forget.mock.calls.map(([relPath]) => relPath)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
