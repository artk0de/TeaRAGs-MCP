/**
 * `cg_symbols_files.content_hash` round trip (bd tea-rags-mcp-6goqa).
 *
 * The table held only `(rel_path, language)`, so the graph could say whether a
 * file was PRESENT but never whether its rows were CURRENT. That is why a dead
 * import edge survived every incremental reindex: the file was in the graph, so
 * nothing re-extracted it. Persisting the ingest snapshot's SHA256 alongside the
 * row is what lets the repair check tell a stale file from a fresh one.
 *
 * A row written before the column existed reads back as NULL, and the repair
 * check treats NULL as "unknown, therefore re-extract" — assuming such rows are
 * current is precisely the assumption that hid the defect.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { GraphEdges } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const NO_EDGES: GraphEdges = { fileEdges: [], methodEdges: [] };

describe("cg_symbols_files — content_hash round trip", () => {
  let dir: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-content-hash-"));
    client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the hash written with a file node", async () => {
    await client.upsertFile({ relPath: "src/a.ts", language: "typescript", contentHash: "abc123" }, NO_EDGES);

    const rows = await client.queryAll<{ rel_path: string; content_hash: string | null }>(
      "SELECT rel_path, content_hash FROM cg_symbols_files",
    );

    expect(rows).toEqual([{ rel_path: "src/a.ts", content_hash: "abc123" }]);
  });

  it("stores NULL when the node carries no hash", async () => {
    await client.upsertFile({ relPath: "src/b.ts", language: "typescript" }, NO_EDGES);

    const rows = await client.queryAll<{ content_hash: string | null }>(
      "SELECT content_hash FROM cg_symbols_files WHERE rel_path = 'src/b.ts'",
    );

    expect(rows[0].content_hash).toBeNull();
  });

  it("replaces the hash when the file is re-extracted with new content", async () => {
    await client.upsertFile({ relPath: "src/c.ts", language: "typescript", contentHash: "old" }, NO_EDGES);
    await client.upsertFile({ relPath: "src/c.ts", language: "typescript", contentHash: "new" }, NO_EDGES);

    const rows = await client.queryAll<{ content_hash: string | null }>(
      "SELECT content_hash FROM cg_symbols_files WHERE rel_path = 'src/c.ts'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe("new");
  });
});
