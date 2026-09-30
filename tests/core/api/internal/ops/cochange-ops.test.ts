/**
 * `CochangeOps` (bd tea-rags-mcp-l1ot.1) — the read pipeline of the
 * `find_co_changed` tool over a REAL temporal co-change store: read the
 * `cg_temporal_*` graph, answer `built:false` when no build has run, and map
 * the persisted provenance row into the response (mode derived from the
 * session-bundling gap).
 *
 * The store is exercised through `DuckDbGraphClient` + the real migrations —
 * the same fixture pattern as `client-temporal-cochange.test.ts` — so the
 * response shape asserted here is the shape the store actually produces, not a
 * hand-built fixture of an imagined shape (mcp-tool-schemas invariant 4).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { MissingArgumentError } from "../../../../../src/core/api/errors.js";
import { CochangeOps } from "../../../../../src/core/api/internal/ops/cochange-ops.js";
import type {
  TemporalCochangeEdge,
  TemporalCochangeSnapshot,
} from "../../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const META = {
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
  sessionGapMinutes: null as number | null,
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

function snapshot(edges: TemporalCochangeEdge[], meta = META): TemporalCochangeSnapshot {
  const files = [...new Set(edges.flatMap((e) => [e.relPathA, e.relPathB]))].map((relPath) => ({
    relPath,
    bundleCount: 4,
    partnerCount: 1,
    lastChangedAt: 1_700_000_000,
  }));
  return { meta, files, edges };
}

describe("CochangeOps#find", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-cochange-ops-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers built:false with every requested file listed but empty, when no build has run", async () => {
    const result = await new CochangeOps().find(db, { files: ["a.ts", "b.ts"] });

    expect(result).toEqual({
      built: false,
      files: [
        { relPath: "a.ts", inGraph: false, partners: [] },
        { relPath: "b.ts", inGraph: false, partners: [] },
      ],
    });
    expect("provenance" in result).toBe(false);
  });

  it("returns partners with the persisted metrics and provenance over a real build", async () => {
    await db.upsertFile(
      { relPath: "b.ts", language: "typescript" },
      { fileEdges: [{ targetRelPath: "a.ts", importText: "./a" }], methodEdges: [] },
    );
    await db.replaceTemporalCochange(snapshot([edge("a.ts", "b.ts"), edge("a.ts", "lonely.yml")]));

    const result = await new CochangeOps().find(db, { files: ["b.ts"] });

    expect(result.built).toBe(true);
    expect(result.provenance).toEqual({
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
      mode: "commit",
    });
    expect(result.files).toEqual([
      {
        relPath: "b.ts",
        inGraph: true,
        partners: [
          {
            relPath: "a.ts",
            support: 3,
            // Queried b.ts (the stored B side): P(a.ts|b.ts) = confidenceBA, P(b.ts|a.ts) = confidenceAB.
            pPartnerGivenFile: 0.5,
            pFileGivenPartner: 0.75,
            strength: expect.any(Number),
            lift: 4.5,
            lastCoChangeAt: 1_700_000_000,
            sampleCommits: ["s3", "s2", "s1"],
            // The linkage verdict is the store's own SQL join (a real file
            // edge joins the pair), not recomputed by the ops layer.
            structurallyLinked: true,
          },
        ],
      },
    ]);
  });

  it("derives mode 'session' from the persisted session-bundling gap", async () => {
    await db.replaceTemporalCochange(snapshot([edge("a.ts", "b.ts")], { ...META, sessionGapMinutes: 30 }));

    const result = await new CochangeOps().find(db, { files: ["a.ts"] });

    expect(result.provenance?.mode).toBe("session");
    expect(result.provenance?.sessionGapMinutes).toBe(30);
  });

  it("normalizes a leading ./ on the requested files", async () => {
    await db.replaceTemporalCochange(snapshot([edge("a.ts", "b.ts")]));

    const result = await new CochangeOps().find(db, { files: ["./a.ts"] });

    expect(result.files[0].relPath).toBe("a.ts");
    expect(result.files[0].inGraph).toBe(true);
  });

  it("applies the default limit of 10 partners per file after ranking", async () => {
    const edges = Array.from({ length: 12 }, (_, i) => edge(`p${String(i).padStart(2, "0")}.ts`, "target.ts", 3 + i));
    await db.replaceTemporalCochange(snapshot(edges));

    const result = await new CochangeOps().find(db, { files: ["target.ts"] });

    expect(result.files[0].partners).toHaveLength(10);
  });

  it("honours an explicit limit", async () => {
    const edges = Array.from({ length: 5 }, (_, i) => edge(`p${i}.ts`, "target.ts"));
    await db.replaceTemporalCochange(snapshot(edges));

    const result = await new CochangeOps().find(db, { files: ["target.ts"], limit: 2 });

    expect(result.files[0].partners).toHaveLength(2);
  });

  it("drops a partner whose file no longer exists when a liveness predicate is given", async () => {
    await db.replaceTemporalCochange(snapshot([edge("deleted.ts", "target.ts", 9), edge("alive.ts", "target.ts", 4)]));

    const result = await new CochangeOps().find(db, { files: ["target.ts"] }, (relPath) => relPath !== "deleted.ts");

    expect(result.files[0].partners.map((p) => p.relPath)).toEqual(["alive.ts"]);
  });

  it("rejects a request with no files", async () => {
    await expect(new CochangeOps().find(db, { files: [] })).rejects.toThrow(MissingArgumentError);
  });
});
