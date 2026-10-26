/**
 * `find_co_changed` empty answers explain themselves (agent turn economy N6, bd
 * tea-rags-mcp-wrosj): `built: false` also says `empty.reason: "notBuilt"` at
 * the top level, and a queried file the built graph holds no history for says
 * `empty.reason: "noHistory"` on its own row — the answer is per file, so the
 * reason is too.
 */
import { describe, expect, it, vi } from "vitest";

import { CochangeOps } from "../../../../../src/core/api/internal/ops/cochange-ops.js";
import type { TemporalCochangeGraph } from "../../../../../src/core/contracts/types/codegraph.js";

const META = { head: "abc", builtAt: 1, windowSince: 0, commitCount: 3 };

function graphDb(graph: Partial<TemporalCochangeGraph>) {
  return { readTemporalCochangeGraph: vi.fn(async () => graph as TemporalCochangeGraph) };
}

const EDGE = {
  relPathA: "a.ts",
  relPathB: "b.ts",
  support: 3,
  confidenceAB: 0.75,
  confidenceBA: 0.5,
  lift: 4.5,
  lastCoChangeAt: 1,
  sampleCommits: ["s1"],
  structurallyLinked: false,
};

describe("CochangeOps — empty answers (N6)", () => {
  it("built:false carries a top-level notBuilt explanation", async () => {
    const result = await new CochangeOps().find(graphDb({ meta: null, edges: [] }), { files: ["a.ts"] });

    expect(result.built).toBe(false);
    expect(result.empty?.reason).toBe("notBuilt");
    expect(result.empty?.message).toMatch(/enrichment|index/);
  });

  it("the no-graph-database fallback carries the same notBuilt explanation", () => {
    expect(CochangeOps.empty(["a.ts"]).empty?.reason).toBe("notBuilt");
  });

  it("a queried file with no stored partner carries noHistory on its row; a file with partners carries none", async () => {
    const db = graphDb({ meta: META as never, edges: [EDGE] });
    const result = await new CochangeOps().find(db, { files: ["a.ts", "new.ts"] });

    expect(result.built).toBe(true);
    expect("empty" in result).toBe(false);
    const [known, unknown] = result.files;
    expect("empty" in known).toBe(false);
    expect(unknown).toMatchObject({ relPath: "new.ts", inGraph: false, partners: [], empty: { reason: "noHistory" } });
    expect(unknown.empty?.message).toMatch(/new\.ts/);
  });
});
