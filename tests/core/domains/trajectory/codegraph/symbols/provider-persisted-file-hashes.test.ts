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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  /**
   * The write half of the repair, and the assumption the whole self-healing
   * design rests on (bd tea-rags-mcp-gvw8h): re-extracting the drifted set must
   * leave the DERIVED tables consistent with it, not just the base rows. A
   * repair that refreshed `cg_symbols_edges_file` while `cg_symbols_cycles` kept
   * serving a cycle the source no longer has would be worse than no repair —
   * `find_cycles` would still be wrong, and the run that was supposed to fix it
   * would report success.
   */
  it("rebuilds the derived tables from the repaired graph, not just the base rows", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cg-repair-derived-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      // a ↔ b: a genuine two-file circular dependency.
      writeFileSync(
        join(repo, "src", "a.ts"),
        'import { b } from "./b.js";\nexport function a(): number {\n  return b();\n}\n',
      );
      writeFileSync(
        join(repo, "src", "b.ts"),
        'import { a } from "./a.js";\nexport function b(): number {\n  return a() + 1;\n}\n',
      );

      const opts = { collectionName: "code_repair_v1" };
      await provider.streamFileBatch(repo, ["src/a.ts", "src/b.ts"], opts);
      await provider.finalizeSignals(repo, opts);

      const { graphDb } = await pool.acquire("code_repair_v1");
      expect(await graphDb.findCycles("file")).not.toHaveLength(0);

      // The cycle is broken in source. Only a.ts drifted, so only a.ts is in the
      // repair set — the same one-sided set `runRepairPass` hands the executor.
      writeFileSync(join(repo, "src", "a.ts"), "export function a(): number {\n  return 1;\n}\n");
      await provider.buildFileSignals(repo, {
        paths: ["src/a.ts"],
        ...opts,
        contentHashes: new Map([["src/a.ts", "after"]]),
      });

      expect(await graphDb.findCycles("file")).toHaveLength(0);
      // ...and the repaired row now carries the hash it was repaired to, so the
      // next run's check converges instead of repairing the same file forever.
      expect((await provider.readPersistedFileHashes("code_repair_v1")).get("src/a.ts")).toBe("after");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
