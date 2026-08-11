/**
 * `replacePageRanks` rewrites cg_symbols_metrics wholesale on every graph
 * finalize: DELETE the table, then batch-INSERT the new ranks, in one
 * transaction.
 *
 * With an ART index over the DOUBLE `page_rank` column, DuckDB 1.5.3 aborts
 * that DELETE with "Failed to delete all rows from index. Only deleted 0 out of
 * N rows" — a FATAL that invalidates the database handle for the rest of the
 * process. Everything the run had still to write is then lost, which is how a
 * codegraph run could finish with the resolve breakdown missing (snbzk).
 *
 * So the invariant under test is simply: replacing the ranks twice must work,
 * and the second set must be what survives.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../src/core/domains/maintenance/migration/database/migrations");

describe("DuckDbGraphClient.replacePageRanks", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-pagerank-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Enough rows that the delete goes through the index path, not a shortcut. */
  function ranks(count: number, base: number): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < count; i++) out.set(`Sym${i}#method`, base + i * 1e-7);
    return out;
  }

  it("replaces a populated table without invalidating the database", async () => {
    await client.replacePageRanks(ranks(800, 0.0002));

    // The second replace is the one that used to abort: the table is populated,
    // so the DELETE has real rows to remove from the index.
    await expect(client.replacePageRanks(ranks(800, 0.0009))).resolves.toBeUndefined();

    expect(await client.getPageRank("Sym0#method")).toBeCloseTo(0.0009, 6);
  });

  it("leaves the handle usable for later writes", async () => {
    // A fatal here would surface on the NEXT statement as "database has been
    // invalidated because of a previous fatal error".
    await client.replacePageRanks(ranks(800, 0.0002));
    await client.replacePageRanks(ranks(800, 0.0005));

    await expect(client.replaceCycles("method", [["Sym1#method", "Sym2#method"]])).resolves.toBeUndefined();
  });

  it("drops ranks that are absent from the new set", async () => {
    await client.replacePageRanks(ranks(800, 0.0002));

    await client.replacePageRanks(new Map([["Sym0#method", 0.5]]));

    expect(await client.getPageRank("Sym0#method")).toBeCloseTo(0.5, 6);
    expect(await client.getPageRank("Sym799#method")).toBe(0);
  });
});
