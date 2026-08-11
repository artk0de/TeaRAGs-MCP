import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { RelPath, SymbolId } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("migration 007 — cg_symbols.chunk_id", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // 007 shipped the nullable column together with a `symbol_id` index. The
  // column is the invariant; the index was one way to serve the lookup it
  // enabled, and 019 removed it — an ART on this table silently voids the scoped
  // DELETE that rewrites a file's symbols (bd tea-rags-mcp-oucyv). What 007
  // actually promises is that a symbol can be found by id, which the round-trip
  // cases below pin directly.
  it("adds a nullable chunk_id column after init", async () => {
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

    await client.close();
  });
});

describe("DuckDbGraphClient — chunk_id read/write", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips chunk_id: upsert symbols, backfill chunk_id, find by symbolId", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-rw-"));
    const client = new DuckDbGraphClient({ path: join(dir, "graph.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);

    const rel = "app/models/foo.rb" as RelPath;
    await client.upsertSymbols(rel, [
      {
        symbolId: "Foo" as SymbolId,
        fqName: "Foo",
        shortName: "Foo",
        relPath: rel,
        scope: [],
      },
      {
        symbolId: "Foo#bar" as SymbolId,
        fqName: "Foo#bar",
        shortName: "bar",
        relPath: rel,
        scope: ["Foo"],
      },
    ]);

    // Before backfill: no covering chunk → null.
    expect(await client.findSymbolChunk("Foo#bar" as SymbolId)).toBeNull();

    // Empty map is a no-op (early return, no transaction).
    await client.updateSymbolChunkIds(rel, new Map());

    await client.updateSymbolChunkIds(rel, new Map([["Foo#bar" as SymbolId, "chunk_abc123def456"]]));

    expect(await client.findSymbolChunk("Foo#bar" as SymbolId)).toEqual({
      relPath: rel,
      chunkId: "chunk_abc123def456",
    });
    // Symbol with no backfilled chunk_id stays null.
    expect(await client.findSymbolChunk("Foo" as SymbolId)).toBeNull();
    // Unknown symbol → null.
    expect(await client.findSymbolChunk("Nope#x" as SymbolId)).toBeNull();

    await client.close();
  });
});

describe("DuckDbGraphClient — findSymbolChunk last-segment fallback (DSL symbols)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<DuckDbGraphClient> {
    dir = mkdtempSync(join(tmpdir(), "cg-lastseg-"));
    const client = new DuckDbGraphClient({ path: join(dir, "graph.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);

    // A Rails `scope :suspended` defined inside the `Account::Suspensions`
    // concern: codegraph mints `Account::Suspensions.suspended`, but the
    // covering body chunk's payload symbolId is the parent module, so the
    // Qdrant scroll and the exact-match tier both miss the host/bare query.
    const concern = "app/models/concerns/account/suspensions.rb" as RelPath;
    await client.upsertSymbols(concern, [
      {
        symbolId: "Account::Suspensions" as SymbolId,
        fqName: "Account::Suspensions",
        shortName: "Suspensions",
        relPath: concern,
        scope: ["Account"],
      },
      {
        symbolId: "Account::Suspensions.suspended" as SymbolId,
        fqName: "Account::Suspensions.suspended",
        shortName: "suspended",
        relPath: concern,
        scope: ["Account", "Suspensions"],
      },
    ]);
    await client.updateSymbolChunkIds(
      concern,
      new Map([["Account::Suspensions.suspended" as SymbolId, "chunk_scope_suspended"]]),
    );
    return client;
  }

  it("resolves a bare last-segment query to the DSL symbol's covering chunk", async () => {
    const client = await seed();

    expect(await client.findSymbolChunk("suspended" as SymbolId)).toEqual({
      relPath: "app/models/concerns/account/suspensions.rb",
      chunkId: "chunk_scope_suspended",
    });

    await client.close();
  });

  it("resolves a host-class form (`Account.suspended`) by last name segment", async () => {
    const client = await seed();

    // The benchmark form — the scope is USED as `Account.suspended` though it
    // lives in the concern `Account::Suspensions`.
    expect(await client.findSymbolChunk("Account.suspended" as SymbolId)).toEqual({
      relPath: "app/models/concerns/account/suspensions.rb",
      chunkId: "chunk_scope_suspended",
    });

    await client.close();
  });

  it("still resolves the canonical exact FQN via the exact tier", async () => {
    const client = await seed();

    expect(await client.findSymbolChunk("Account::Suspensions.suspended" as SymbolId)).toEqual({
      relPath: "app/models/concerns/account/suspensions.rb",
      chunkId: "chunk_scope_suspended",
    });

    await client.close();
  });

  it("prefers an exact match over a last-segment match", async () => {
    const client = await seed();
    const other = "app/models/other.rb" as RelPath;
    await client.upsertSymbols(other, [
      {
        symbolId: "Other#suspended" as SymbolId,
        fqName: "Other#suspended",
        shortName: "suspended",
        relPath: other,
        scope: ["Other"],
      },
    ]);
    await client.updateSymbolChunkIds(other, new Map([["Other#suspended" as SymbolId, "chunk_other_suspended"]]));

    // Exact query must hit its own chunk, never the same-tail neighbour.
    expect(await client.findSymbolChunk("Other#suspended" as SymbolId)).toEqual({
      relPath: "app/models/other.rb",
      chunkId: "chunk_other_suspended",
    });

    await client.close();
  });

  it("treats `_` in the last segment literally (no LIKE wildcard leak)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-underscore-"));
    const client = new DuckDbGraphClient({ path: join(dir, "graph.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);

    const rel = "app/models/account_filter.rb" as RelPath;
    await client.upsertSymbols(rel, [
      {
        symbolId: "AccountFilter#status_scope" as SymbolId,
        fqName: "AccountFilter#status_scope",
        shortName: "status_scope",
        relPath: rel,
        scope: ["AccountFilter"],
      },
    ]);
    await client.updateSymbolChunkIds(rel, new Map([["AccountFilter#status_scope" as SymbolId, "chunk_status_scope"]]));

    // `_` must match a literal underscore only — `statusXscope` must NOT hit.
    expect(await client.findSymbolChunk("statusXscope" as SymbolId)).toBeNull();
    // The literal underscore form resolves.
    expect(await client.findSymbolChunk("status_scope" as SymbolId)).toEqual({
      relPath: "app/models/account_filter.rb",
      chunkId: "chunk_status_scope",
    });

    await client.close();
  });

  it("returns null when no symbol shares the query's last segment", async () => {
    const client = await seed();

    expect(await client.findSymbolChunk("nonexistent_member" as SymbolId)).toBeNull();

    await client.close();
  });
});
