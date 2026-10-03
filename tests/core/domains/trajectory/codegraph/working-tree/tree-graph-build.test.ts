/**
 * `buildWorkingTreeGraph` — the PRODUCTION incremental codegraph run over a
 * working-tree delta, against a private clone of the base graph (epic xi2r9,
 * WTO-7). Every case builds a real base graph from TypeScript fixture files,
 * edits a copy of the project the way a working tree differs from its indexed
 * commit, builds the tree graph, and reads the OUTPUT database READ_ONLY to
 * assert exactly which method edges left and which arrived.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildWorkingTreeGraph,
  type WorkingTreeGraphBuildInput,
  type WorkingTreeGraphBuilt,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-build.js";
import {
  buildTreeGraphFixture,
  cleanupTreeGraphFixtures,
  LANGUAGE_MODULE_PATH,
  methodEdgeRowsFrom,
  methodEdges,
  MIGRATIONS_MODULE_PATH,
  PHYSICAL,
  sha256OfFile,
  symbolKeys,
  withReadOnlyGraph,
  type TreeGraphFixture,
} from "./__helpers__/tree-graph-fixture.js";

afterAll(() => {
  cleanupTreeGraphFixtures();
});

function inputFor(
  fixture: TreeGraphFixture,
  changedRelPaths: string[],
  deletedRelPaths: string[],
): WorkingTreeGraphBuildInput {
  return {
    snapshotPath: fixture.snapshotPath,
    outputRoot: fixture.outputRoot,
    physicalCollectionName: PHYSICAL,
    treeRoot: fixture.treeRoot,
    changedRelPaths,
    deletedRelPaths,
    providerConfig: {
      languageModulePath: LANGUAGE_MODULE_PATH,
      migrationsModulePath: MIGRATIONS_MODULE_PATH,
    },
  };
}

// ─── Fixture: one base, one tree, one build — read by every case below ────────

const X_BASE = `export function x(): number {
  return 1;
}

export function y(): number {
  return 2;
}
`;
// The tree declares `z`, which the base never had.
const X_TREE = `${X_BASE}
export function z(): number {
  return 3;
}
`;
const A_BASE = `import { x } from "./x";

export function run(): number {
  return x();
}
`;
const A_TREE = `import { y, z } from "./x";

export function run(): number {
  return y() + z();
}
`;
// Unchanged in the tree: one call into an unchanged target, one into a changed
// file whose target survives, one into the file the tree deletes.
const U_SRC = `import { k } from "./k";
import { y } from "./x";
import { doomed } from "./d";

export function useK(): number {
  return k();
}

export function useY(): number {
  return y();
}

export function callDoomed(): number {
  return doomed();
}
`;
const K_SRC = `export function k(): number {
  return 7;
}
`;
const D_SRC = `import { k } from "./k";

export function doomed(): number {
  return k();
}
`;
// Changed in the tree but still importing from the deleted file: it may only
// resolve into `d.ts` if the deletion left the in-memory symbol table stale.
const STALE_BASE = `export function stale(): number {
  return 0;
}
`;
const STALE_TREE = `import { doomed } from "./d";

export function stale(): number {
  return doomed();
}
`;
const R_SRC = `export function renamed(): number {
  return 4;
}
`;
const RC_BASE = `import { renamed } from "./r-old";

export function callRenamed(): number {
  return renamed();
}
`;
const RC_TREE = `import { renamed } from "./r-new";

export function callRenamed(): number {
  return renamed();
}
`;
const M1_BASE = `export function helper(): number {
  return 5;
}

export function stay(): number {
  return 6;
}
`;
const M1_TREE = `export function stay(): number {
  return 6;
}
`;
const M2_TREE = `export function helper(): number {
  return 5;
}
`;
const MC_BASE = `import { helper } from "./m1";

export function useHelper(): number {
  return helper();
}
`;
const MC_TREE = `import { helper } from "./m2";

export function useHelper(): number {
  return helper();
}
`;

const BASE_FILES = {
  "src/x.ts": X_BASE,
  "src/a.ts": A_BASE,
  "src/u.ts": U_SRC,
  "src/k.ts": K_SRC,
  "src/d.ts": D_SRC,
  "src/stale.ts": STALE_BASE,
  "src/r-old.ts": R_SRC,
  "src/rc.ts": RC_BASE,
  "src/m1.ts": M1_BASE,
  "src/mc.ts": MC_BASE,
};

describe("buildWorkingTreeGraph — edge matrix over one tree build", () => {
  let fixture: TreeGraphFixture;
  let built: WorkingTreeGraphBuilt;
  let baseEdges: string[];
  let snapshotShaBefore: string;
  let snapshotShaAfter: string;

  beforeAll(async () => {
    fixture = await buildTreeGraphFixture(BASE_FILES);
    baseEdges = await methodEdges(fixture.snapshotPath);
    snapshotShaBefore = sha256OfFile(fixture.snapshotPath);

    fixture.writeTree("src/x.ts", X_TREE);
    fixture.writeTree("src/a.ts", A_TREE);
    fixture.writeTree("src/stale.ts", STALE_TREE);
    fixture.removeTree("src/d.ts");
    fixture.removeTree("src/r-old.ts");
    fixture.writeTree("src/r-new.ts", R_SRC);
    fixture.writeTree("src/rc.ts", RC_TREE);
    fixture.writeTree("src/m1.ts", M1_TREE);
    fixture.writeTree("src/m2.ts", M2_TREE);
    fixture.writeTree("src/mc.ts", MC_TREE);

    built = await buildWorkingTreeGraph(
      inputFor(
        fixture,
        ["src/x.ts", "src/a.ts", "src/stale.ts", "src/r-new.ts", "src/rc.ts", "src/m1.ts", "src/m2.ts", "src/mc.ts"],
        ["src/d.ts", "src/r-old.ts"],
      ),
    );
    snapshotShaAfter = sha256OfFile(fixture.snapshotPath);
  }, 120_000);

  it("the base graph holds the edges the tree is about to move (fixture sanity)", () => {
    expect(baseEdges).toEqual(
      expect.arrayContaining([
        "src/a.ts#run -> src/x.ts#x",
        "src/u.ts#callDoomed -> src/d.ts#doomed",
        "src/d.ts#doomed -> src/k.ts#k",
        "src/rc.ts#callRenamed -> src/r-old.ts#renamed",
        "src/mc.ts#useHelper -> src/m1.ts#helper",
      ]),
    );
  });

  it("writes the graph to <outputRoot>/codegraph/<physical>.duckdb and reports the delta it applied", () => {
    expect(built.dbPath).toBe(join(fixture.outputRoot, "codegraph", `${PHYSICAL}.duckdb`));
    expect(built.walkedFileCount).toBe(8);
    expect(built.deletedFileCount).toBe(2);
    expect(built.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("modified caller: the edge to x is gone, the edge to y is present", async () => {
    const edges = await methodEdges(built.dbPath);
    expect(edges).not.toContain("src/a.ts#run -> src/x.ts#x");
    expect(edges).toContain("src/a.ts#run -> src/x.ts#y");
  });

  it("tree-only symbol: z, declared only by the tree, gains its caller from another changed file", async () => {
    const edges = await methodEdges(built.dbPath);
    expect(edges).toContain("src/a.ts#run -> src/x.ts#z");
    expect(await symbolKeys(built.dbPath)).toContain("src/x.ts#z");
  });

  it("an unchanged file's edges survive byte-identical, into unchanged and changed targets alike", async () => {
    const baseRows = await methodEdgeRowsFrom(fixture.snapshotPath, "src/u.ts");
    const treeRows = await methodEdgeRowsFrom(built.dbPath, "src/u.ts");
    const intoSurvivors = (rows: string[]): string[] => rows.filter((row) => !row.includes('"src/d.ts"'));
    expect(intoSurvivors(treeRows)).toEqual(intoSurvivors(baseRows));
    expect(intoSurvivors(treeRows).length).toBeGreaterThanOrEqual(2);
  });

  it("deleted file: its symbols, its outgoing edges and the incoming edge from an UNCHANGED caller are gone", async () => {
    const edges = await methodEdges(built.dbPath);
    expect(edges.filter((edge) => edge.includes("src/d.ts"))).toEqual([]);
    expect((await symbolKeys(built.dbPath)).filter((key) => key.startsWith("src/d.ts#"))).toEqual([]);
  });

  it("deletion leaves the in-memory symbol table too: a changed file importing the deleted one resolves nothing into it", async () => {
    const edges = await methodEdges(built.dbPath);
    expect(edges.filter((edge) => edge.startsWith("src/stale.ts#") && edge.includes("src/d.ts"))).toEqual([]);
  });

  it("rename: edges point at the new relPath and none at the old", async () => {
    const edges = await methodEdges(built.dbPath);
    expect(edges).toContain("src/rc.ts#callRenamed -> src/r-new.ts#renamed");
    expect(edges.filter((edge) => edge.includes("src/r-old.ts"))).toEqual([]);
    expect((await symbolKeys(built.dbPath)).filter((key) => key.startsWith("src/r-old.ts#"))).toEqual([]);
  });

  it("move of a function between two changed files: the caller re-points", async () => {
    const edges = await methodEdges(built.dbPath);
    expect(edges).toContain("src/mc.ts#useHelper -> src/m2.ts#helper");
    expect(edges).not.toContain("src/mc.ts#useHelper -> src/m1.ts#helper");
    expect(await symbolKeys(built.dbPath)).not.toContain("src/m1.ts#helper");
  });

  it("metrics: the tree-only symbol carries a fresh PageRank row and the derived tables are not stale", async () => {
    await withReadOnlyGraph(built.dbPath, async (client) => {
      const rows = await client.queryAll<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM cg_symbols_metrics WHERE rel_path = 'src/x.ts' AND symbol_id = 'z'",
      );
      expect(Number(rows[0]?.n)).toBe(1);
      expect(await client.hasStaleDerivedTables()).toBe(false);
      const deadRanks = await client.queryAll<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM cg_symbols_metrics WHERE rel_path IN ('src/d.ts', 'src/r-old.ts')",
      );
      expect(Number(deadRanks[0]?.n)).toBe(0);
    });
  });

  it("the output database is self-contained: no non-empty WAL beside it", () => {
    const wal = `${built.dbPath}.wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
  });

  it("never writes the base snapshot", () => {
    expect(snapshotShaAfter).toBe(snapshotShaBefore);
    expect(existsSync(`${fixture.snapshotPath}.wal`)).toBe(false);
  });
});

// ─── Hierarchy dependents of a deletion, cycles of a tree-only symbol ─────────

const API_SRC = `export interface Closer {
  close(): void;
}

export function drain(c: Closer): void {
  c.close();
}
`;
const implementer = (name: string): string => `import type { Closer } from "./api";

export class ${name} implements Closer {
  close(): void {
    console.log("${name}");
  }
}
`;

describe("buildWorkingTreeGraph — what an incremental reindex re-derives beyond the delta", () => {
  it("deleting an implementer re-resolves the UNCHANGED caller whose cone held it", async () => {
    const fixture = await buildTreeGraphFixture({
      "src/api.ts": API_SRC,
      "src/a.ts": implementer("A"),
      "src/b.ts": implementer("B"),
      "src/c.ts": implementer("C"),
    });
    const drainCallees = async (dbPath: string): Promise<string[]> =>
      (await methodEdges(dbPath)).filter((edge) => edge.startsWith("src/api.ts#drain ->")).sort();
    expect(await drainCallees(fixture.snapshotPath)).toEqual([
      "src/api.ts#drain -> src/a.ts#A#close",
      "src/api.ts#drain -> src/b.ts#B#close",
      "src/api.ts#drain -> src/c.ts#C#close",
    ]);
    fixture.removeTree("src/c.ts");

    const built = await buildWorkingTreeGraph(inputFor(fixture, [], ["src/c.ts"]));

    expect(await drainCallees(built.dbPath)).toEqual([
      "src/api.ts#drain -> src/a.ts#A#close",
      "src/api.ts#drain -> src/b.ts#B#close",
    ]);
    expect(built.hierarchyDependentCount).toBe(1);
    expect(built.walkedFileCount).toBe(1);
    expect(built.deletedFileCount).toBe(1);
  }, 120_000);

  it("a deletion-only delta with no dependents still recomputes the derived tables", async () => {
    const fixture = await buildTreeGraphFixture({
      "src/k.ts": K_SRC,
      "src/d.ts": D_SRC,
      "src/e.ts": `import { k } from "./k";\n\nexport function e(): number {\n  return k();\n}\n`,
    });
    fixture.removeTree("src/d.ts");

    const built = await buildWorkingTreeGraph(inputFor(fixture, [], ["src/d.ts"]));

    expect(built.walkedFileCount).toBe(0);
    await withReadOnlyGraph(built.dbPath, async (client) => {
      expect(await client.hasStaleDerivedTables()).toBe(false);
      const ranks = await client.queryAll<{ k: string }>(
        "SELECT rel_path || '#' || symbol_id AS k FROM cg_symbols_metrics ORDER BY 1",
      );
      expect(ranks.map((r) => r.k)).toEqual(["src/e.ts#e", "src/k.ts#k"]);
    });
  }, 120_000);

  it("a cycle only the tree closes is in cg_symbols_cycles", async () => {
    const fixture = await buildTreeGraphFixture({
      "src/p.ts": `export function p(): number {\n  return 1;\n}\n`,
    });
    fixture.writeTree("src/p.ts", `import { q } from "./q";\n\nexport function p(): number {\n  return q();\n}\n`);
    fixture.writeTree("src/q.ts", `import { p } from "./p";\n\nexport function q(): number {\n  return p();\n}\n`);

    const built = await buildWorkingTreeGraph(inputFor(fixture, ["src/p.ts", "src/q.ts"], []));

    await withReadOnlyGraph(built.dbPath, async (client) => {
      const cycles = await client.findCycles("method");
      expect(cycles).toHaveLength(1);
    });
  }, 120_000);
});

describe("buildWorkingTreeGraph — programming errors", () => {
  it("refuses an empty delta", async () => {
    const fixture = await buildTreeGraphFixture({ "src/k.ts": K_SRC });
    await expect(buildWorkingTreeGraph(inputFor(fixture, [], []))).rejects.toThrow(/empty/i);
  }, 120_000);
});
