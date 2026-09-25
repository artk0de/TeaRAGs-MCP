/**
 * A full `--force` rebuild starts from an EMPTY graph (epic tea-rags-mcp-4p3sb,
 * case 10 of the dead-symbol matrix in `provider-dead-symbols.test.ts`).
 *
 * Invariant: no row outlives its source. A full rebuild runs no repair pass and
 * prunes no orphan (`IndexPipeline` never calls `runRepairPass`), so it cannot
 * clean a graph it inherits — the guarantee has to be that it inherits none.
 * That rests on two mechanisms, both pinned here:
 *
 *  1. The graph DB is addressed by the PHYSICAL versioned collection name. A
 *     rebuild claims `<base>_v<N+1>` (`claimVersionedCollection`), and its
 *     DuckDB file is `CodegraphDbFiles#pathFor(<base>_v<N+1>)` — a different
 *     file from the one the live `_vN` generation serves. Nothing copies `_vN`'s
 *     rows forward; `cloneDatabase` is reached only by the worktree footprint
 *     saga (`CodegraphArtifact#clone`).
 *  2. A stale `<base>_v<N+1>.duckdb` a killed earlier build left on disk, whose
 *     Qdrant collection is gone, is unlinked by `sweepCodegraphOrphans` before
 *     the claim (`IndexPipeline` runs `cleanupOrphanedVersions` and the sweep
 *     first), so the new generation cannot open it.
 *
 * Bug history: bd tea-rags-mcp-dy852 (3e24ffa0a) and bd tea-rags-mcp-dvzdm
 * (b53f5faf4) are the incremental faces of this class; the full-rebuild face is
 * guarded by construction, which is what this file states and pins.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixtureCollectionAlias } from "../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { CodegraphDbFiles } from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";
import { sweepCodegraphOrphans } from "../../../../src/core/domains/ingest/infra/alias-cleanup.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";
import { versionedPhysicalCollectionName } from "../../../../src/core/infra/collection-name.js";

const BASE = fixtureCollectionAlias("code_force");
const V1 = versionedPhysicalCollectionName(BASE, 1);
const V2 = versionedPhysicalCollectionName(BASE, 2);

describe("full --force rebuild opens an empty codegraph (case 10)", () => {
  let root: string;
  let files: CodegraphDbFiles;
  const open: DuckDbGraphClient[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cg-force-fresh-"));
    files = new CodegraphDbFiles(root);
  });

  afterEach(async () => {
    for (const c of open.splice(0)) await c.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function openGraph(path: string): Promise<DuckDbGraphClient> {
    const client = new DuckDbGraphClient({ path });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    open.push(client);
    return client;
  }

  /** A generation holding a dead method, its identifiers, an edge and a rank. */
  async function populate(client: DuckDbGraphClient): Promise<void> {
    await client.upsertSymbolsBulk([
      {
        relPath: "app/a.rb",
        definitions: [{ relPath: "app/a.rb", symbolId: "A#dead", fqName: "A#dead", shortName: "dead", scope: [] }],
      },
    ]);
    await client.upsertFile(
      { relPath: "app/b.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          { sourceSymbolId: "B#x", targetSymbolId: "A#dead", targetRelPath: "app/a.rb", callExpression: "a.dead" },
        ],
      },
    );
    await client.replaceIdentifiersBulk([
      { relPath: "app/a.rb", rows: [{ ownerSymbolId: "A#dead", kind: "param", name: "d", line: 1 }] },
    ]);
    await client.replacePageRanks(new Map([["app/a.rb|A#dead", 1]]));
  }

  /** Row count of every `cg_*` base table. */
  async function rowCounts(client: DuckDbGraphClient): Promise<Record<string, number>> {
    const tables = await client.queryAll<{ table_name: string }>(
      "SELECT table_name FROM duckdb_tables() WHERE table_name LIKE 'cg\\_%' ESCAPE '\\' ORDER BY table_name",
    );
    const counts: Record<string, number> = {};
    for (const { table_name } of tables) {
      const [row] = await client.queryAll<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${table_name}`);
      const n = Number(row?.n ?? 0);
      if (n > 0) counts[table_name] = n;
    }
    return counts;
  }

  it("the next generation's graph is a different file, and it holds no row of the previous one", async () => {
    const live = await openGraph(files.writablePathFor(V1));
    await populate(live);
    expect(Object.keys(await rowCounts(live))).toEqual(
      expect.arrayContaining(["cg_symbols", "cg_symbols_edges_method", "cg_identifiers", "cg_symbols_metrics"]),
    );

    expect(files.pathFor(V2)).not.toBe(files.pathFor(V1));
    const rebuilt = await openGraph(files.writablePathFor(V2));

    // Only the migration ledger carries over into a fresh file; no graph row does.
    const carried = Object.keys(await rowCounts(rebuilt)).filter((t) => !/migration/i.test(t));
    expect(carried).toEqual([]);
  });

  it("a stale graph file a killed build left under the next version is swept before the rebuild opens it", async () => {
    const leftover = await openGraph(files.writablePathFor(V2));
    await populate(leftover);
    await leftover.close();
    open.splice(open.indexOf(leftover), 1);
    expect(files.has(V2)).toBe(true);

    // Qdrant: the alias serves _v1, and the killed build's _v2 collection is gone.
    const qdrant = {
      aliases: { listAliases: async () => [{ aliasName: BASE, collectionName: V1 }] },
      listCollections: async () => [V1],
    };
    const removed = await sweepCodegraphOrphans(
      qdrant as never,
      BASE,
      (base) => files.listCollectionDbNames(base),
      async (name) => files.removeFiles(name),
    );

    expect(removed).toBe(1);
    expect(files.has(V2)).toBe(false);
    const rebuilt = await openGraph(files.writablePathFor(V2));
    const carried = Object.keys(await rowCounts(rebuilt)).filter((t) => !/migration/i.test(t));
    expect(carried).toEqual([]);
  });
});
