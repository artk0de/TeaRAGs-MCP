/**
 * Can a `cg_symbols_edges_file` row name a target with no `cg_symbols_files`
 * row (bd tea-rags-mcp-9f613)?
 *
 * `writeFileRows` inserts edges unfiltered and the schema declares no FK to
 * `cg_symbols_files` — deliberately, per the note in `001-cg-symbols-init.sql`.
 * The suspicion was that `.d.ts` is the hole: `SOURCE_EXTENSION_CANDIDATES` lets
 * a relative import resolve to a declaration file, and declaration files were
 * assumed never to be walked.
 *
 * They are walked. `extensionOf` is a `lastIndexOf(".")`, so `types.d.ts` reads
 * as `.ts`, clears the supported-extension gate, and is noded like any other
 * TypeScript source — no exclusion pattern and no language glob singles it out.
 * The first test pins that as an invariant instead of an accident.
 *
 * Dangling targets are still reachable, just by a different route: the mapper
 * probes the filesystem, while the node set comes from `discoverSupportedFiles`,
 * which applies the codegraph exclusion filter. Any import landing on a file
 * that exists on disk but is excluded from the graph dangles, whatever its
 * extension. The second test pins that shape and pins the consequence that
 * decides the severity — such a target is a pure sink, so it cannot reach
 * `find_cycles`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { GraphDbClientPool } from "../../../../../../src/core/adapters/duckdb/pool.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { createDatabaseMigrationApplier } from "../../../../../../src/core/domains/maintenance/migration/database/index.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface EdgeRow {
  source_rel_path: string;
  target_rel_path: string;
}

/** Raw-SQL handle. `GraphDbClient` does not declare `queryAll`; the pooled
 *  in-process handle really is a `DuckDbGraphClient`, which does. */
interface RawQueryable {
  queryAll: <T>(sql: string) => Promise<T[]>;
}

describe("cg_symbols_edges_file target rows (bd tea-rags-mcp-9f613)", () => {
  let tmp: string;
  let repo: string;
  let pool: GraphDbClientPool;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-dts-edge-"));
    repo = mkdtempSync(join(tmpdir(), "cg-dts-repo-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });
    // `TypescriptLanguage` roots both its tsconfig load and its filesystem
    // probe at `process.cwd()` at construction time, so the fixture has to be
    // the working directory while the provider is built — otherwise the probe
    // answers about the wrong tree and the mapper falls back to its unverified
    // first candidate, which would make these assertions measure the harness
    // rather than the resolver.
    const originalCwd = process.cwd();
    process.chdir(repo);
    try {
      provider = new CodegraphEnrichmentProvider({
        pool,
        ...buildTestCodegraphDeps(),
        composer: new DefaultSymbolIdComposer(),
        collectSymbols,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  afterEach(async () => {
    await pool.closeAll();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  async function readGraph(collectionName: string): Promise<{ edges: EdgeRow[]; known: Set<string> }> {
    const { graphDb } = await pool.acquire(collectionName);
    const db = graphDb as unknown as RawQueryable;
    const edges = await db.queryAll<EdgeRow>(
      "SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_file ORDER BY source_rel_path, target_rel_path",
    );
    const files = await db.queryAll<{ rel_path: string }>("SELECT rel_path FROM cg_symbols_files");
    return { edges, known: new Set(files.map((f) => f.rel_path)) };
  }

  /**
   * The bead's premise as a test. Both specifier spellings that can select the
   * `.d.ts` candidate are covered: the NodeNext `./types.js` form and the
   * extensionless `./types`. The walk runs off discovery rather than an explicit
   * `paths` list, so it exercises the production path that decides what becomes
   * a node.
   */
  it("nodes a .d.ts import target, so an edge naming one is not dangling", async () => {
    writeFileSync(
      join(repo, "src", "types.d.ts"),
      "export interface Options {\n  retries: number;\n}\nexport declare const DEFAULTS: Options;\n",
    );
    writeFileSync(
      join(repo, "src", "a.ts"),
      'import { DEFAULTS } from "./types.js";\nexport function fromSuffixed(): number {\n  return DEFAULTS.retries;\n}\n',
    );
    writeFileSync(
      join(repo, "src", "b.ts"),
      'import { DEFAULTS } from "./types";\nexport function fromExtensionless(): number {\n  return DEFAULTS.retries;\n}\n',
    );

    await provider.buildFileSignals(repo, { collectionName: "code_dts_v1" });
    const { edges, known } = await readGraph("code_dts_v1");

    // The resolver really did pick the declaration file over the `.ts` that
    // does not exist — without this the rest would be vacuous.
    expect(edges).toContainEqual({ source_rel_path: "src/a.ts", target_rel_path: "src/types.d.ts" });
    expect(edges).toContainEqual({ source_rel_path: "src/b.ts", target_rel_path: "src/types.d.ts" });

    // ...and the declaration file was walked, so both edges resolve.
    expect(known).toContain("src/types.d.ts");

    // Stated as the general invariant rather than the one path.
    expect(edges.filter((e) => !known.has(e.target_rel_path))).toEqual([]);
  });

  /**
   * The case that does dangle — and it turns on codegraph exclusion, not on the
   * extension. A test file exists on disk (so the mapper's probe accepts it) but
   * is kept out of the fan-graph (so it is never noded).
   */
  it("dangles on an import to a codegraph-excluded file, and the dangling target stays out of find_cycles", async () => {
    writeFileSync(join(repo, "src", "helper.test.ts"), "export function helper(): number {\n  return 1;\n}\n");
    writeFileSync(
      join(repo, "src", "c.ts"),
      'import { helper } from "./helper.test.js";\nexport function useHelper(): number {\n  return helper();\n}\n',
    );

    await provider.buildFileSignals(repo, { collectionName: "code_excluded_v1" });
    const { edges, known } = await readGraph("code_excluded_v1");

    expect(known).not.toContain("src/helper.test.ts");
    expect(edges).toContainEqual({ source_rel_path: "src/c.ts", target_rel_path: "src/helper.test.ts" });

    // Severity, pinned: a dangling target is only ever a target, never a source,
    // so it is a pure sink. Tarjan keeps components of size >= 2, and a sink can
    // never be in one — the file cycle report is unaffected.
    const { graphDb } = await pool.acquire("code_excluded_v1");
    expect(await graphDb.findCycles("file")).toHaveLength(0);
  });
});
