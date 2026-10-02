/**
 * `createWorkingTreeDeltaSignalSource` (bd tea-rags-mcp-xi2r9, WTO-6/7): delta
 * rows get the trajectory payload ingest would have given them.
 *
 * - git: `git.file` inherited from the base points of the same file (an
 *   uncommitted edit has no history of its own), `git.chunk` from the base
 *   point of the same symbol (`#partN` on either side counts as that symbol); a
 *   symbol the base never had gets no chunk block, an untracked file no git.
 * - codegraph: computed from the TREE graph when it is built within the search
 *   wait (3 s), exactly as the payload heal computes it; otherwise inherited
 *   from the base points like git, and the result says why.
 * - Physical payload keys (`codegraph.symbols.*`), never logical ones.
 *
 * Live probe this pins: a modified `hybrid.ts` delta row under `hotspots` with
 * `filter: {}` ranked #24 at 0.132 — scored as a file with no history.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { createComposition } from "../../../../../src/core/api/internal/composition.js";
import { createWorkingTreeDeltaSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-delta-signals.js";
import type {
  WorkingTree,
  WorkingTreeDeltaRow,
  WorkingTreeGraphReader,
  WorkingTreeGraphState,
} from "../../../../../src/core/contracts/types/working-tree.js";
import { buildWorkingTreeGraph } from "../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-build.js";
import {
  buildTreeGraphFixture,
  cleanupTreeGraphFixtures,
  LANGUAGE_MODULE_PATH,
  MIGRATIONS_MODULE_PATH,
  PHYSICAL,
} from "../../../domains/trajectory/codegraph/working-tree/__helpers__/tree-graph-fixture.js";

const TREE: WorkingTree = { root: "/tree", baseIndex: { collectionName: "code_base", root: "/repo" } };
const FOO = "src/foo.ts";

const GIT_FILE = { commitCount: 40, bugFixRate: 30, churnVolatility: 5, ageDays: 2, relativeChurn: 1.5 };
const gitChunk = (commitCount: number) => ({ commitCount, churnRatio: 0.6, bugFixRate: 25, ageDays: 1 });
const CG_FILE = { fanIn: 3, fanOut: 2, instability: 0.4, connectionCount: 5, isHub: false, isLeaf: false };
const cgChunk = (fanIn: number) => ({ fanIn, fanOut: 1, pageRank: 0.01 });

/** A stored base point of `relativePath` / `symbolId` with git + codegraph payload. */
function basePoint(id: string, relativePath: string, symbolId: string, chunkCommits: number) {
  return {
    id,
    payload: {
      relativePath,
      symbolId,
      git: { file: GIT_FILE, chunk: gitChunk(chunkCommits) },
      codegraph: { symbols: { file: CG_FILE, chunk: cgChunk(chunkCommits) } },
    },
  };
}

function deltaRow(id: string, relativePath: string, symbolId: string, lines = [1, 3]): WorkingTreeDeltaRow {
  return {
    id,
    payload: {
      relativePath,
      symbolId,
      chunkType: "function",
      language: "typescript",
      startLine: lines[0],
      endLine: lines[1],
      content: "",
    },
  };
}

/** A Qdrant fake answering a scroll with the base points of the files the filter names. */
function qdrantHolding(points: ReturnType<typeof basePoint>[]) {
  return {
    scrollFiltered: vi.fn(async (_collection: string, filter: Record<string, unknown>) => {
      const named = JSON.stringify(filter);
      return points.filter((p) => named.includes(`"${p.payload.relativePath}"`));
    }),
  };
}

const unopenable = () => ({
  acquireFileReader: vi.fn(async () => {
    throw new Error("no graph files in this test");
  }),
});

describe("createWorkingTreeDeltaSignalSource", () => {
  describe("git", () => {
    const qdrant = qdrantHolding([
      basePoint("b1", FOO, "Foo#small#part1", 5),
      basePoint("b2", FOO, "Foo#small#part2", 6),
      basePoint("b3", FOO, "Foo#big", 9),
      basePoint("b4", FOO, "Foo#kept", 11),
    ]);
    const source = createWorkingTreeDeltaSignalSource({ qdrant, graphFiles: unopenable });

    it("inherits git.file per file and git.chunk from the base point of the same symbol", async () => {
      const { rows } = await source.enrich({ tree: TREE, rows: [deltaRow("d1", FOO, "Foo#kept")] });

      expect(rows[0].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(11) });
      expect(qdrant.scrollFiltered).toHaveBeenCalledWith(
        "code_base",
        expect.anything(),
        expect.any(Number),
        undefined,
        expect.arrayContaining(["relativePath", "symbolId", "git", "codegraph"]),
      );
    });

    it("matches #partN on either side: the exact id first, else the symbol's first part", async () => {
      const { rows } = await source.enrich({
        tree: TREE,
        rows: [
          deltaRow("d1", FOO, "Foo#small#part2"),
          deltaRow("d2", FOO, "Foo#small"),
          deltaRow("d3", FOO, "Foo#big#part2"),
        ],
      });

      expect((rows[0].payload.git as { chunk: unknown }).chunk).toEqual(gitChunk(6));
      expect((rows[1].payload.git as { chunk: unknown }).chunk).toEqual(gitChunk(5));
      expect((rows[2].payload.git as { chunk: unknown }).chunk).toEqual(gitChunk(9));
    });

    it("gives a symbol the base never had the file's history and no chunk block", async () => {
      const { rows } = await source.enrich({ tree: TREE, rows: [deltaRow("d1", FOO, "Foo#brandNew")] });

      expect(rows[0].payload.git).toEqual({ file: GIT_FILE });
    });

    it("gives a file the base never had no git block at all", async () => {
      const { rows } = await source.enrich({ tree: TREE, rows: [deltaRow("d1", "src/untracked.ts", "fresh")] });

      expect(rows[0].payload).not.toHaveProperty("git");
      expect(rows[0].payload).not.toHaveProperty("codegraph");
    });

    it("keeps the rows' order and their own payload", async () => {
      const input = [deltaRow("d1", FOO, "Foo#kept"), deltaRow("d2", "src/untracked.ts", "fresh")];

      const { rows } = await source.enrich({ tree: TREE, rows: input });

      expect(rows.map((r) => r.id)).toEqual(["d1", "d2"]);
      expect(rows[0].payload).toMatchObject(input[0].payload);
    });
  });

  describe("codegraph inherited from the base", () => {
    const qdrant = qdrantHolding([basePoint("b1", FOO, "Foo#kept", 4)]);

    it("inherits the base block and says why when the tree graph is unavailable", async () => {
      const source = createWorkingTreeDeltaSignalSource({ qdrant, graphFiles: unopenable });
      const readTreeGraph = vi.fn<WorkingTreeGraphReader>(async () => ({ kind: "unavailable", reason: "building" }));

      const result = await source.enrich({ tree: TREE, rows: [deltaRow("d1", FOO, "Foo#kept")], readTreeGraph });

      expect(result.rows[0].payload.codegraph).toEqual({ symbols: { file: CG_FILE, chunk: cgChunk(4) } });
      expect(result.treeGraph).toEqual({ kind: "unavailable", reason: "building" });
      expect(readTreeGraph).toHaveBeenCalledWith(3000);
    });

    it("inherits without asking when no tree graph reader is given", async () => {
      const source = createWorkingTreeDeltaSignalSource({ qdrant, graphFiles: unopenable });

      const result = await source.enrich({ tree: TREE, rows: [deltaRow("d1", FOO, "Foo#kept")] });

      expect(result.rows[0].payload.codegraph).toEqual({ symbols: { file: CG_FILE, chunk: cgChunk(4) } });
      expect(result.treeGraph).toBeUndefined();
    });

    it("inherits and names the failure when a built tree graph cannot be opened", async () => {
      const source = createWorkingTreeDeltaSignalSource({ qdrant, graphFiles: unopenable });
      const built: WorkingTreeGraphState = { kind: "built", dbPath: "/nope.duckdb", physicalCollectionName: PHYSICAL };

      const result = await source.enrich({
        tree: TREE,
        rows: [deltaRow("d1", FOO, "Foo#kept")],
        readTreeGraph: async () => built,
      });

      expect(result.rows[0].payload.codegraph).toEqual({ symbols: { file: CG_FILE, chunk: cgChunk(4) } });
      expect(result.treeGraph?.kind).toBe("unavailable");
    });
  });

  describe("codegraph from the tree graph", { timeout: 120_000 }, () => {
    const X_BASE = `export function x(): number {
  return 1;
}

export function y(): number {
  return 2;
}
`;
    const A_BASE = `import { x } from "./x";

export function run(): number {
  return x();
}
`;
    const A_TREE = `import { y } from "./x";

export function run(): number {
  return y();
}
`;
    let treeDbPath: string;

    beforeAll(async () => {
      const fixture = await buildTreeGraphFixture({ "src/x.ts": X_BASE, "src/a.ts": A_BASE });
      fixture.writeTree("src/a.ts", A_TREE);
      const built = await buildWorkingTreeGraph({
        snapshotPath: fixture.snapshotPath,
        outputRoot: fixture.outputRoot,
        physicalCollectionName: PHYSICAL,
        treeRoot: fixture.treeRoot,
        changedRelPaths: ["src/a.ts"],
        deletedRelPaths: [],
        providerConfig: { languageModulePath: LANGUAGE_MODULE_PATH, migrationsModulePath: MIGRATIONS_MODULE_PATH },
      });
      treeDbPath = built.dbPath;
    }, 120_000);

    afterAll(() => {
      cleanupTreeGraphFixtures();
    });

    const graphFiles = () => ({
      acquireFileReader: vi.fn(async (dbPath: string) => {
        const graphDb = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
        await graphDb.init();
        return { graphDb, symbolTable: {} as never };
      }),
    });

    it("computes file and chunk signals from the tree graph under the physical keys", async () => {
      // The base says y has no caller and x one; the tree moved run()'s call to y.
      const qdrant = qdrantHolding([
        { ...basePoint("bx", "src/x.ts", "x", 0), payload: { ...basePoint("bx", "src/x.ts", "x", 0).payload } },
      ]);
      const source = createWorkingTreeDeltaSignalSource({ qdrant, graphFiles });
      const built: WorkingTreeGraphState = { kind: "built", dbPath: treeDbPath, physicalCollectionName: PHYSICAL };

      const result = await source.enrich({
        tree: TREE,
        rows: [deltaRow("dy", "src/x.ts", "y", [5, 7]), deltaRow("dx", "src/x.ts", "x", [1, 3])],
        readTreeGraph: async () => built,
      });

      const [yRow, xRow] = result.rows;
      const ySymbols = (yRow.payload.codegraph as { symbols: Record<string, Record<string, unknown>> }).symbols;
      const xSymbols = (xRow.payload.codegraph as { symbols: Record<string, Record<string, unknown>> }).symbols;
      expect(ySymbols.chunk.fanIn).toBe(1);
      expect(xSymbols.chunk.fanIn).toBe(0);
      expect(ySymbols.file.fanIn).toBe(1);
      expect(ySymbols.file).toHaveProperty("instability");
      expect(yRow.payload).not.toHaveProperty(["codegraph", "file"]);
      expect(result.treeGraph).toEqual(built);
    });
  });

  describe("ranking (live probe regression)", () => {
    it("ranks an enriched delta row of a modified file with its git history under hotspots", async () => {
      const { reranker } = createComposition();
      const qdrant = qdrantHolding([basePoint("b1", FOO, "Foo#kept", 30)]);
      const source = createWorkingTreeDeltaSignalSource({ qdrant, graphFiles: unopenable });
      const raw = deltaRow("delta", FOO, "Foo#kept", [1, 40]);
      const { rows } = await source.enrich({ tree: TREE, rows: [raw] });

      const [enriched] = await reranker.rerank([{ ...rows[0], score: 0.5 }], "hotspots", "semantic_search");
      const [bare] = await reranker.rerank([{ ...raw, score: 0.5 }], "hotspots", "semantic_search");

      expect(enriched.rankingOverlay?.file).toHaveProperty("bugFixRate");
      expect(enriched.rankingOverlay?.chunk).toHaveProperty("commitCount");
      expect(bare.rankingOverlay?.file ?? {}).not.toHaveProperty("bugFixRate");
      expect(enriched.score).toBeGreaterThan(bare.score);
    });
  });
});
