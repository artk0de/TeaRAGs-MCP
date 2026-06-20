import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

describe("migration 007 — cg_symbols.chunk_id", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds a nullable chunk_id column and a symbol_id index after init", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-chunkid-"));
    const client = new DuckDbGraphClient({ path: join(dir, "graph.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);

    const cols = await client.queryAll<{
      column_name: string;
      is_nullable: string;
    }>("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'cg_symbols'");
    const chunkId = cols.find((c) => c.column_name === "chunk_id");
    expect(chunkId).toBeDefined();
    expect(chunkId!.is_nullable).toBe("YES");

    const idx = await client.queryAll<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cg_symbols'",
    );
    expect(idx.map((r) => r.index_name)).toContain("idx_cg_symbols_symbol");

    await client.close();
  });
});
