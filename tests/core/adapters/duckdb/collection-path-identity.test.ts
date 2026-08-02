/**
 * One logical collection, one DuckDB file (bd tea-rags-mcp-6goqa).
 *
 * This is the regression guard for the whole defect. The codegraph pool derives
 * its file path from the literal string it is handed, while Qdrant resolves an
 * alias to the same physical collection either way — so handing the alias to
 * the write path and the resolved name to the read path produced two files that
 * looked equally plausible and never met. Seven of 44 aliased projects ended up
 * with a shadow DB nobody read.
 *
 * Both directions are resolved here the way production resolves them: the write
 * path through `resolveAliasTargetCollection` (ingest), the read path through
 * the alias expansion `GraphFacade` performs before touching the pool. They
 * must land on the same path, and neither may land on the unversioned name
 * while the collection is a live alias.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { resolveAliasTargetCollection } from "../../../../src/core/domains/ingest/operations/version-resolver.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ALIASES = [
  { aliasName: "code_x", collectionName: "code_x_v52" },
  { aliasName: "code_other", collectionName: "code_other_v3" },
];

/** What GraphFacade does before it touches the pool: expand the alias. */
function readPathName(collectionName: string): string {
  return ALIASES.find((a) => a.aliasName === collectionName)?.collectionName ?? collectionName;
}

describe("collection path identity", () => {
  let tmp: string;
  let pool: GraphDbClientPool;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-path-identity-"));
    pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });
  });

  afterEach(async () => {
    await pool.closeAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("write and read resolve the same DuckDB file for an aliased collection", () => {
    const writePath = pool.pathFor(resolveAliasTargetCollection("code_x", ALIASES));
    const readPath = pool.pathFor(readPathName("code_x"));

    expect(writePath).toBe(readPath);
  });

  it("never derives the unversioned path while the collection is a live alias", () => {
    const writePath = pool.pathFor(resolveAliasTargetCollection("code_x", ALIASES));

    expect(writePath).toBe(join(tmp, "codegraph", "code_x_v52.duckdb"));
    expect(writePath).not.toBe(join(tmp, "codegraph", "code_x.duckdb"));
  });

  it("still agrees for a collection that is not an alias at all", () => {
    // Migration-era projects address a real, unversioned collection. Both sides
    // must keep resolving to the literal name — the fix must not push those
    // onto a versioned path that does not exist.
    const writePath = pool.pathFor(resolveAliasTargetCollection("code_plain", ALIASES));
    const readPath = pool.pathFor(readPathName("code_plain"));

    expect(writePath).toBe(readPath);
    expect(writePath).toBe(join(tmp, "codegraph", "code_plain.duckdb"));
  });
});
