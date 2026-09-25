/**
 * The temporal co-change store (bd tea-rags-mcp-x4rpp): wholesale replace of
 * `cg_temporal_*`, the provenance read the builder compares against HEAD, and
 * the graph read the silent-coupling detector judges.
 *
 * Invariants under test:
 *   - `replaceTemporalCochange` swaps all three tables at once — nothing of a
 *     previous build survives the next one;
 *   - `readTemporalCochangeMeta` is `null` before the first build;
 *   - `readTemporalCochangeGraph` annotates each pair with whether a file edge
 *     OR a resolved method edge joins its endpoints, in either direction — an
 *     unresolved method edge (no target symbol) is not a structural link.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  TemporalCochangeBuildMeta,
  TemporalCochangeEdge,
  TemporalCochangeSnapshot,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const META: TemporalCochangeBuildMeta = {
  head: "abc123",
  fingerprint: "fp-1",
  builtAt: 1_700_000_100,
  windowSince: 1_690_000_000,
  commitCount: 40,
  bundleCount: 30,
  admittedBundleCount: 28,
  maxFilesPerBundle: 12,
  minSupport: 2,
  maxPartnersPerFile: 20,
  sessionGapMinutes: null,
};

function edge(relPathA: string, relPathB: string, support = 3): TemporalCochangeEdge {
  return {
    relPathA,
    relPathB,
    support,
    confidenceAB: 0.75,
    confidenceBA: 0.5,
    lift: 4.5,
    lastCoChangeAt: 1_700_000_000,
    sampleCommits: ["s3", "s2", "s1"],
  };
}

function snapshot(edges: TemporalCochangeEdge[], meta: TemporalCochangeBuildMeta = META): TemporalCochangeSnapshot {
  const files = [...new Set(edges.flatMap((e) => [e.relPathA, e.relPathB]))].map((relPath) => ({
    relPath,
    bundleCount: 4,
    partnerCount: 1,
    lastChangedAt: 1_700_000_000,
  }));
  return { meta, files, edges };
}

describe("DuckDbGraphClient — temporal co-change store (bd tea-rags-mcp-x4rpp)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-temporal-store-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads no meta and no edges before the first build", async () => {
    expect(await db.readTemporalCochangeMeta()).toBeNull();
    expect(await db.readTemporalCochangeGraph()).toEqual({ meta: null, edges: [] });
  });

  it("round-trips a build and replaces it wholesale on the next one", async () => {
    await db.replaceTemporalCochange(snapshot([edge("a.ts", "b.ts"), edge("a.ts", "c.yml")]));
    await db.replaceTemporalCochange(snapshot([edge("b.ts", "d.ts", 5)], { ...META, head: "def456" }));

    expect(await db.readTemporalCochangeMeta()).toEqual({ ...META, head: "def456" });
    const graph = await db.readTemporalCochangeGraph();
    expect(graph.edges).toEqual([{ ...edge("b.ts", "d.ts", 5), structurallyLinked: false }]);
    expect(await db.queryAll("SELECT rel_path FROM cg_temporal_files ORDER BY rel_path")).toEqual([
      { rel_path: "b.ts" },
      { rel_path: "d.ts" },
    ]);
  });

  it("marks a pair linked by a file edge or a resolved method edge in either direction", async () => {
    await db.upsertFile(
      { relPath: "b.ts", language: "typescript" },
      { fileEdges: [{ targetRelPath: "a.ts", importText: "./a" }], methodEdges: [] },
    );
    await db.upsertFile(
      { relPath: "c.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          { sourceSymbolId: "run", targetSymbolId: "Svc#go", targetRelPath: "d.ts", callExpression: "svc.go()" },
          { sourceSymbolId: "run", targetSymbolId: null, targetRelPath: "e.ts", callExpression: "x.y()" },
        ],
      },
    );
    await db.replaceTemporalCochange(
      snapshot([edge("a.ts", "b.ts"), edge("c.ts", "d.ts"), edge("c.ts", "e.ts"), edge("a.ts", "z.yml")]),
    );

    const linked = Object.fromEntries(
      (await db.readTemporalCochangeGraph()).edges.map((e) => [`${e.relPathA}|${e.relPathB}`, e.structurallyLinked]),
    );
    expect(linked).toEqual({ "a.ts|b.ts": true, "c.ts|d.ts": true, "c.ts|e.ts": false, "a.ts|z.yml": false });
  });
});
