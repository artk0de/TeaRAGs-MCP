/**
 * The codegraph store refuses to CREATE a shadow database (bd tea-rags-mcp-39xca.1).
 *
 * A shadow is `<base>.duckdb` written beside `<base>_v<N>.duckdb` generations:
 * the file an alias-addressed write opens when it should have opened the
 * versioned physical collection (6goqa, snbzk, xjkvw). The type system keeps an
 * alias away from the pool; this guard is the runtime backstop for the one
 * place that could still create the wrong file. Opening a file that already
 * exists is never refused — the orphan sweep must still be able to reach it.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodegraphDbFiles } from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";
import { CodegraphShadowDatabaseRefusedError } from "../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { InfraError } from "../../../../src/core/adapters/errors.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("GraphDbClientPool — refuses to create a shadow database (39xca.1)", () => {
  let tmp: string;
  let pool: GraphDbClientPool;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pool-shadow-guard-"));
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

  it("rejects a write acquire of <base> while <base>_vN generations exist, and creates no file", async () => {
    writeFileSync(join(tmp, "codegraph", "code_x_v3.duckdb"), "");

    await expect(pool.acquireWrite("code_x")).rejects.toBeInstanceOf(CodegraphShadowDatabaseRefusedError);

    expect(existsSync(join(tmp, "codegraph", "code_x.duckdb"))).toBe(false);
  });

  it("still opens a <base> database that already exists beside its generations", async () => {
    await pool.acquireWrite("code_x");
    await pool.release("code_x");
    writeFileSync(join(tmp, "codegraph", "code_x_v3.duckdb"), "");

    const handle = await pool.acquireWrite("code_x");

    expect(handle.graphDb).toBeDefined();
  });

  it("creates a database for a name that has no generations of its own", async () => {
    // `code_x_v4` shares a prefix with the `code_x` family but is itself a
    // generation: nothing named `code_x_v4_vN` exists, so it is not a shadow.
    writeFileSync(join(tmp, "codegraph", "code_x_v3.duckdb"), "");

    await pool.acquireWrite("code_x_v4");
    await pool.acquireWrite("code_plain");

    expect(existsSync(join(tmp, "codegraph", "code_x_v4.duckdb"))).toBe(true);
    expect(existsSync(join(tmp, "codegraph", "code_plain.duckdb"))).toBe(true);
  });
});

describe("CodegraphDbFiles — refuses to clone into a shadow database (39xca.1)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cg-files-shadow-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a clone whose target is <base> while <base>_vN generations exist, and copies nothing", async () => {
    const files = new CodegraphDbFiles(root);
    const dir = join(root, "codegraph");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code_src_v1.duckdb"), "source");
    writeFileSync(join(dir, "code_t_v2.duckdb"), "");

    await expect(files.cloneDatabase("code_src_v1", "code_t")).rejects.toBeInstanceOf(
      CodegraphShadowDatabaseRefusedError,
    );

    expect(existsSync(join(dir, "code_t.duckdb"))).toBe(false);
  });
});

describe("CodegraphShadowDatabaseRefusedError", () => {
  it("is a 500 InfraError naming the refused path and the generations that made it a shadow", () => {
    const err = new CodegraphShadowDatabaseRefusedError({
      collectionName: "code_x",
      dbPath: "/tmp/codegraph/code_x.duckdb",
      generations: ["code_x_v3"],
    });

    expect(err).toBeInstanceOf(InfraError);
    expect(err.code).toBe("INFRA_CODEGRAPH_SHADOW_DATABASE_REFUSED");
    expect(err.message).toContain("/tmp/codegraph/code_x.duckdb");
    expect(err.message).toContain("code_x_v3");
    expect(err.httpStatus).toBe(500);
  });
});
