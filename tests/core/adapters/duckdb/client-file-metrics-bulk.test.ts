/**
 * `getFileMetricsBulk` — the set-based read-back that replaces the 3-per-file
 * `getFanIn` + `getFanOut` + `getTransitiveImpact` loop in
 * `CodegraphEnrichmentProvider#readFileOverlays` (the post-pass-2 finalize tail).
 *
 * Equivalence invariant under test: for EVERY requested root the bulk map's
 * {fanIn, fanOut, transitiveImpact} equals what the three per-file getters
 * return for that same root — PER ROOT, never summed or shared. The setwise
 * recursive CTE walks all roots in one statement, so the hazard it must not
 * have is a root's reverse-reachable set leaking into another root's count.
 * The fixture graph is built to expose exactly that: two roots whose blast
 * radii overlap on a shared subtree, plus an import cycle that walks the
 * recursion back to its own seed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { RelPath } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient — getFileMetricsBulk (finalize read-back)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-bulk-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One import edge per line: `source imports target`. */
  async function importsFrom(source: RelPath, targets: RelPath[]): Promise<void> {
    await db.upsertFile(
      { relPath: source, language: "typescript" },
      {
        fileEdges: targets.map((t) => ({ targetRelPath: t, importText: `./${t}` })),
        methodEdges: [],
      },
    );
  }

  /**
   * Two overlapping blast radii + a cycle + a chain deeper than the depth cap.
   *
   *   b, c, hub → a        (a has three direct importers)
   *   d → b, d → c         (d reaches a by TWO paths — the shared subtree)
   *   e → d,  a → e        (cycle: a → e → d → b → a)
   *   deep6 → … → deep1 → root   (6 hops — the 6th must fall outside depth 5)
   *   orphan                (no edges at all)
   */
  async function seed(): Promise<void> {
    await importsFrom("b.ts", ["a.ts"]);
    await importsFrom("c.ts", ["a.ts"]);
    await importsFrom("hub.ts", ["a.ts"]);
    await importsFrom("d.ts", ["b.ts", "c.ts"]);
    await importsFrom("e.ts", ["d.ts"]);
    await importsFrom("a.ts", ["e.ts"]);
    await importsFrom("deep1.ts", ["root.ts"]);
    await importsFrom("deep2.ts", ["deep1.ts"]);
    await importsFrom("deep3.ts", ["deep2.ts"]);
    await importsFrom("deep4.ts", ["deep3.ts"]);
    await importsFrom("deep5.ts", ["deep4.ts"]);
    await importsFrom("deep6.ts", ["deep5.ts"]);
    await importsFrom("orphan.ts", []);
  }

  const universe: RelPath[] = [
    "a.ts",
    "b.ts",
    "c.ts",
    "d.ts",
    "e.ts",
    "hub.ts",
    "root.ts",
    "deep1.ts",
    "deep5.ts",
    "deep6.ts",
    "orphan.ts",
    "never/indexed.ts",
  ];

  it("matches the per-file getters for every root (shared subtrees, cycles, depth cap)", async () => {
    await seed();

    const bulk = await db.getFileMetricsBulk(universe);

    for (const relPath of universe) {
      const expected = {
        fanIn: await db.getFanIn(relPath),
        fanOut: await db.getFanOut(relPath),
        transitiveImpact: await db.getTransitiveImpact(relPath),
      };
      const got = bulk.get(relPath);
      expect({
        fanIn: got?.fanIn ?? 0,
        fanOut: got?.fanOut ?? 0,
        transitiveImpact: got?.transitiveImpact ?? 0,
      }).toEqual(expected);
    }

    // Concrete spot-checks so a per-file getter regressing in the SAME way as
    // the bulk read cannot make the loop above vacuously pass.
    //
    // a.ts: direct importers b, c, hub; then d (via both b and c — counted
    // once); then e. The cycle walks back to a itself, which is excluded.
    expect(bulk.get("a.ts")).toEqual({ fanIn: 3, fanOut: 1, transitiveImpact: 5 });
    // root.ts: deep1..deep5 are within depth 5, deep6 is one hop too far.
    expect(bulk.get("root.ts")?.transitiveImpact).toBe(5);
    // orphan.ts has a file row but no edge in either direction, so it is ABSENT
    // from the map (same contract as getChunkSignalsBulk) — the caller's `?? 0`
    // reproduces what the per-file getters return for it.
    expect(bulk.has("orphan.ts")).toBe(false);
    expect(await db.getFanIn("orphan.ts")).toBe(0);
  });

  it("threads maxDepth per call, matching the per-file getter at the same depth", async () => {
    await seed();

    const bulk = await db.getFileMetricsBulk(["root.ts", "a.ts"], 2);

    expect(bulk.get("root.ts")?.transitiveImpact).toBe(await db.getTransitiveImpact("root.ts", 2));
    expect(bulk.get("root.ts")?.transitiveImpact).toBe(2); // deep1 + deep2 only
    expect(bulk.get("a.ts")?.transitiveImpact).toBe(await db.getTransitiveImpact("a.ts", 2));
  });

  it("returns only the requested roots — a file outside the request never appears", async () => {
    await seed();

    const bulk = await db.getFileMetricsBulk(["a.ts"]);

    expect([...bulk.keys()]).toEqual(["a.ts"]);
  });

  it("returns an empty map for an empty request and for a freshly migrated graph", async () => {
    expect((await db.getFileMetricsBulk([])).size).toBe(0);
    // No seed: every requested root is unknown, so nothing is reported and the
    // caller's `?? 0` default stands in — same as the per-file getters.
    const bulk = await db.getFileMetricsBulk(["a.ts", "b.ts"]);
    for (const relPath of ["a.ts", "b.ts"]) {
      expect(bulk.get(relPath)?.fanIn ?? 0).toBe(await db.getFanIn(relPath));
      expect(bulk.get(relPath)?.transitiveImpact ?? 0).toBe(await db.getTransitiveImpact(relPath));
    }
  });
});
