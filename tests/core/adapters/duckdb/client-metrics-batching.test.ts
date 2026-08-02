/**
 * replacePageRanks / replaceCycles at volume — the batching boundary pin.
 *
 * Both run once per finalize over the WHOLE graph (taxdome: 35145 PageRank rows,
 * 2907 cycle members), so they are written as multi-row INSERTs. Multi-row
 * statements chunk, and chunking is exactly where an off-by-one silently drops
 * or duplicates rows — a per-row loop has no boundaries to get wrong.
 *
 * These pin the observable contract at sizes that span several chunks: every
 * value round-trips, a second call REPLACES rather than accumulates, member
 * order within a cycle survives, and the two scopes stay independent.
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

/** Comfortably more than one insert chunk, and not a multiple of it. */
const VOLUME = 451;

describe("DuckDbGraphClient metrics writes at volume", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-metrics-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("replacePageRanks", () => {
    const ranksOf = (count: number, scale: number): Map<string, number> =>
      new Map(Array.from({ length: count }, (_, i) => [`Mod${i}.run`, (i + 1) * scale]));

    it("round-trips every rank across chunk boundaries", async () => {
      const ranks = ranksOf(VOLUME, 1e-6);
      await client.replacePageRanks(ranks);

      // Spot-check the ends and both sides of every chunk boundary rather than
      // all 451 — a chunking bug shows up exactly there.
      for (const i of [0, 199, 200, 399, 400, VOLUME - 1]) {
        expect(await client.getPageRank(`Mod${i}.run`)).toBeCloseTo((i + 1) * 1e-6, 12);
      }
    });

    it("replaces the previous set instead of accumulating", async () => {
      await client.replacePageRanks(ranksOf(VOLUME, 1e-6));
      await client.replacePageRanks(ranksOf(3, 0.25));

      expect(await client.getPageRank("Mod0.run")).toBeCloseTo(0.25, 12);
      // Beyond the second, smaller set → gone, not left over from the first.
      expect(await client.getPageRank(`Mod${VOLUME - 1}.run`)).toBe(0);
    });
  });

  describe("replaceCycles", () => {
    it("preserves member order within a cycle across chunk boundaries", async () => {
      const big = Array.from({ length: VOLUME }, (_, i) => `Big${i}.m`);
      await client.replaceCycles("method", [big, ["Small0.m", "Small1.m"]]);

      const found = await client.findCycles("method");
      const byId = new Map(found.map((c) => [c.cycleId, c.members]));
      expect(byId.get(0)).toEqual(big);
      expect(byId.get(1)).toEqual(["Small0.m", "Small1.m"]);
    });

    it("replaces only its own scope", async () => {
      await client.replaceCycles("method", [["M0.m", "M1.m"]]);
      await client.replaceCycles("file", [["a.ts", "b.ts"]]);

      await client.replaceCycles("file", [["c.ts", "d.ts"]]);

      expect((await client.findCycles("method")).map((c) => c.members)).toEqual([["M0.m", "M1.m"]]);
      expect((await client.findCycles("file")).map((c) => c.members)).toEqual([["c.ts", "d.ts"]]);
    });
  });
});
