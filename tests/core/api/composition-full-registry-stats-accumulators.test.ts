/**
 * The stats accumulators the FULL trajectory registry declares.
 *
 * The stats migration recomputes a collection's percentiles from payload
 * already on disk, outside any indexing run, so it cannot ask a live registry
 * what to accumulate. It asks this accessor instead — and an accumulator
 * missing from it does not fail loudly: `distributions` comes back without the
 * counts that accumulator owned, and `perLanguage` silently empties out,
 * because the per-language share gate divides by a language count nothing
 * produced.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStubPool } from "../__helpers__/codegraph-pool.js";
import { DuckDbGraphClient } from "../../../src/core/adapters/duckdb/client.js";
import { createComposition, fullRegistryStatsAccumulators } from "../../../src/core/api/internal/composition.js";
import { STATS_ACCUMULATOR_KEYS } from "../../../src/core/contracts/types/stats-accumulator.js";
import { InMemoryGlobalSymbolTable } from "../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("fullRegistryStatsAccumulators", () => {
  let tmp: string;
  let graphDb: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "full-registry-stats-"));
    graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await graphDb.init();
  });
  afterEach(async () => {
    await graphDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("covers every accumulator a composition with every trajectory registers", () => {
    const registered = createComposition({
      codegraph: { pool: createStubPool(graphDb, new InMemoryGlobalSymbolTable()) },
    }).allStatsAccumulators;
    const declared = new Set(fullRegistryStatsAccumulators().map((accumulator) => accumulator.key));

    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((accumulator) => !declared.has(accumulator.key)).map((a) => a.key)).toEqual([]);
  });

  // `totalFiles` is the denominator the stats migration compares a file-scope
  // sample against to decide whether that sample counted files or chunks.
  // Lose the accumulator behind it and every collection reads as up-to-date.
  it("declares the distinct-path accumulator that totalFiles is built from", () => {
    const declared = new Set(fullRegistryStatsAccumulators().map((accumulator) => accumulator.key));

    expect(declared.has(STATS_ACCUMULATOR_KEYS.DISTINCT_PATHS)).toBe(true);
    expect(declared.has(STATS_ACCUMULATOR_KEYS.LANGUAGE_COUNTS)).toBe(true);
  });
});
