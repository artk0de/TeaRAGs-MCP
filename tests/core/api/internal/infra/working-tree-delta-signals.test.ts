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
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createGitWorkingTreeFixture } from "../../../__helpers__/git-working-tree-fixture.js";
import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { createComposition } from "../../../../../src/core/api/internal/composition.js";
import { createWorkingTreeDeltaSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-delta-signals.js";
import { createWorkingTreeGitSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-git-signals.js";
import type {
  WorkingTree,
  WorkingTreeBasePoint,
  WorkingTreeDeltaRow,
  WorkingTreeDeltaSignalRequest,
  WorkingTreeGitSignals,
  WorkingTreeGitSignalSource,
  WorkingTreeGraphReader,
  WorkingTreeGraphState,
  WorkingTreeTouchedBasePointsReader,
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

/**
 * The view's touched-base-point read (`WorkingTreeView#readTouchedBasePoints`):
 * the base points of every touched file, grouped by path. The source reads base
 * payload through it and only through it — it holds no Qdrant of its own.
 */
function basePointsHolding(points: ReturnType<typeof basePoint>[]) {
  return vi.fn<WorkingTreeTouchedBasePointsReader>(async () => {
    const byPath = new Map<string, WorkingTreeBasePoint[]>();
    for (const point of points) {
      const path = point.payload.relativePath;
      byPath.set(path, [...(byPath.get(path) ?? []), point]);
    }
    return byPath;
  });
}

/** The source as the overlay drives it: every request carries the view's base-point read. */
function sourceReading(
  readTouchedBasePoints: WorkingTreeTouchedBasePointsReader,
  graphFiles: Parameters<typeof createWorkingTreeDeltaSignalSource>[0]["graphFiles"],
) {
  const source = createWorkingTreeDeltaSignalSource({ graphFiles });
  return {
    enrich: async (request: WorkingTreeDeltaSignalRequest) => source.enrich({ ...request, readTouchedBasePoints }),
  };
}

const unopenable = () => ({
  acquireFileReader: vi.fn(async () => {
    throw new Error("no graph files in this test");
  }),
});

describe("createWorkingTreeDeltaSignalSource", () => {
  describe("git", () => {
    const readTouchedBasePoints = basePointsHolding([
      basePoint("b1", FOO, "Foo#small#part1", 5),
      basePoint("b2", FOO, "Foo#small#part2", 6),
      basePoint("b3", FOO, "Foo#big", 9),
      basePoint("b4", FOO, "Foo#kept", 11),
    ]);
    const source = sourceReading(readTouchedBasePoints, unopenable);

    it("inherits git.file per file and git.chunk from the base point of the same symbol", async () => {
      const { rows } = await source.enrich({ tree: TREE, rows: [deltaRow("d1", FOO, "Foo#kept")] });

      expect(rows[0].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(11) });
      // Base payload comes from the view's shared touched-base-point read, never
      // a scroll of the source's own (bd tea-rags-mcp-xi2r9: its multi-path
      // `relativePath` scroll cost 4.5 s on every request at 137 delta files).
      expect(readTouchedBasePoints).toHaveBeenCalled();
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
    const readTouchedBasePoints = basePointsHolding([basePoint("b1", FOO, "Foo#kept", 4)]);

    it("inherits the base block and says why when the tree graph is unavailable", async () => {
      const source = sourceReading(readTouchedBasePoints, unopenable);
      const readTreeGraph = vi.fn<WorkingTreeGraphReader>(async () => ({ kind: "unavailable", reason: "building" }));

      const result = await source.enrich({ tree: TREE, rows: [deltaRow("d1", FOO, "Foo#kept")], readTreeGraph });

      expect(result.rows[0].payload.codegraph).toEqual({ symbols: { file: CG_FILE, chunk: cgChunk(4) } });
      expect(result.treeGraph).toEqual({ kind: "unavailable", reason: "building" });
      expect(readTreeGraph).toHaveBeenCalledWith(3000);
    });

    it("inherits without asking when no tree graph reader is given", async () => {
      const source = sourceReading(readTouchedBasePoints, unopenable);

      const result = await source.enrich({ tree: TREE, rows: [deltaRow("d1", FOO, "Foo#kept")] });

      expect(result.rows[0].payload.codegraph).toEqual({ symbols: { file: CG_FILE, chunk: cgChunk(4) } });
      expect(result.treeGraph).toBeUndefined();
    });

    it("inherits and names the failure when a built tree graph cannot be opened", async () => {
      const source = sourceReading(readTouchedBasePoints, unopenable);
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
      const readTouchedBasePoints = basePointsHolding([
        { ...basePoint("bx", "src/x.ts", "x", 0), payload: { ...basePoint("bx", "src/x.ts", "x", 0).payload } },
      ]);
      const source = sourceReading(readTouchedBasePoints, graphFiles);
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

    // Live C1: the view enriches the rows an answer admits, file by file — a
    // row must carry the same blocks whichever batch it was enriched in.
    it("gives a row the payload it gets beside the whole delta when enriched alone", async () => {
      const source = sourceReading(basePointsHolding([basePoint("bx", "src/x.ts", "x", 0)]), graphFiles);
      const built: WorkingTreeGraphState = { kind: "built", dbPath: treeDbPath, physicalCollectionName: PHYSICAL };
      const all = [deltaRow("dy", "src/x.ts", "y", [5, 7]), deltaRow("da", "src/a.ts", "run", [3, 5])];

      const whole = await source.enrich({ tree: TREE, rows: all, readTreeGraph: async () => built });
      const alone = await Promise.all(
        all.map(async (row) => source.enrich({ tree: TREE, rows: [row], readTreeGraph: async () => built })),
      );

      expect(alone.map((result) => result.rows[0])).toEqual(whole.rows);
    });
  });

  describe("ranking (live probe regression)", () => {
    it("ranks an enriched delta row of a modified file with its git history under hotspots", async () => {
      const { reranker } = createComposition();
      const readTouchedBasePoints = basePointsHolding([basePoint("b1", FOO, "Foo#kept", 30)]);
      const source = sourceReading(readTouchedBasePoints, unopenable);
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

/**
 * D12 (bd tea-rags-mcp-xi2r9): delta rows the same-path inheritance left
 * without git — a file renamed in the tree, whose history is its OLD path's;
 * a tracked file the base held no point for (a 3-line file below the chunk
 * floor); a row whose symbol the base never held. Their `git.file` /
 * `git.chunk` come from the git trajectory on demand, asked only for what no
 * base point answers. A file with no history at all keeps no git block.
 */
describe("createWorkingTreeDeltaSignalSource — git beyond the same path", () => {
  const OLD = "src/old-name.ts";
  const NEW = "src/new-name.ts";
  const SMALL = "src/cyc/c.ts";
  const ON_DEMAND_FILE = { commitCount: 3, bugFixRate: 0, lastModifiedAt: 1_700_000_000 };
  const onDemandChunk = (commitCount: number) => ({ commitCount, churnRatio: 1, bugFixRate: 0 });

  function sourceWith(points: ReturnType<typeof basePoint>[], gitSignals?: WorkingTreeGitSignalSource) {
    const source = createWorkingTreeDeltaSignalSource({
      graphFiles: unopenable,
      ...(gitSignals ? { gitSignals } : {}),
    });
    const readTouchedBasePoints = basePointsHolding(points);
    return {
      enrich: async (request: WorkingTreeDeltaSignalRequest) => source.enrich({ ...request, readTouchedBasePoints }),
    };
  }

  /**
   * A port answering per history path: a file block, and chunk blocks by row
   * key; `committedSince` — the paths a commit since the index touched.
   */
  const answering = (
    signals: Record<string, { file?: Record<string, unknown>; chunks?: Record<string, Record<string, unknown>> }>,
    committedSince?: readonly string[],
  ) => ({
    pathsCommittedSince: vi.fn<WorkingTreeGitSignalSource["pathsCommittedSince"]>(async () =>
      committedSince ? new Set(committedSince) : undefined,
    ),
    signalsOf: vi.fn<WorkingTreeGitSignalSource["signalsOf"]>(async (_root, targets) => {
      const answer = new Map<string, WorkingTreeGitSignals>();
      for (const target of targets) {
        const known = signals[target.relativePath];
        if (!known) continue;
        answer.set(target.relativePath, {
          ...(target.fileSignals && known.file ? { file: known.file } : {}),
          chunks: new Map(
            target.chunks.filter((c) => known.chunks?.[c.key]).map((c) => [c.key, known.chunks?.[c.key] ?? {}]),
          ),
        });
      }
      return answer;
    }),
  });

  it("inherits git.file and git.chunk by symbol from the old path of a renamed file", async () => {
    const source = sourceWith([basePoint("b1", OLD, "Foo#kept", 7), basePoint("b2", OLD, "Foo#other", 2)]);

    const { rows } = await source.enrich({
      tree: TREE,
      rows: [deltaRow("d1", NEW, "Foo#kept"), deltaRow("d2", NEW, "Foo#brandNew")],
      renamedFrom: new Map([[NEW, OLD]]),
    });

    expect(rows[0].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(7) });
    // No git port wired: a symbol the base never held keeps the file's history only.
    expect(rows[1].payload.git).toEqual({ file: GIT_FILE });
    expect(rows[0].payload.relativePath).toBe(NEW);
  });

  it("computes git.file and git.chunk on demand for a tracked file the base holds no point for", async () => {
    const gitSignals = answering({ [SMALL]: { file: ON_DEMAND_FILE, chunks: { d1: onDemandChunk(2) } } });
    const source = sourceWith([basePoint("b1", FOO, "Foo#kept", 4)], gitSignals);

    const { rows } = await source.enrich({
      tree: TREE,
      rows: [deltaRow("d1", SMALL, "c", [1, 3]), deltaRow("d2", FOO, "Foo#kept")],
    });

    expect(rows[0].payload.git).toEqual({ file: ON_DEMAND_FILE, chunk: onDemandChunk(2) });
    expect(rows[1].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(4) });
    // Only what no base point answers is asked for, in the TREE file's lines.
    expect(gitSignals.signalsOf).toHaveBeenCalledTimes(1);
    // Round-4 P1: computed with the config of the index the tree is read against.
    expect(gitSignals.signalsOf).toHaveBeenCalledWith(
      TREE.root,
      [
        {
          relativePath: SMALL,
          treePath: SMALL,
          maxEndLine: 3,
          // Round 5: the tree file's line count the enrichment policy reads.
          fileLines: 3,
          fileSignals: true,
          chunks: [{ key: "d1", startLine: 1, endLine: 3 }],
        },
      ],
      undefined,
      TREE.baseIndex.root,
    );
  });

  it("asks only for git.chunk of a symbol the base never held in a file it holds", async () => {
    const gitSignals = answering({ [FOO]: { file: ON_DEMAND_FILE, chunks: { d2: onDemandChunk(5) } } });
    const source = sourceWith([basePoint("b1", FOO, "Foo#kept", 4)], gitSignals);

    const { rows } = await source.enrich({
      tree: TREE,
      rows: [deltaRow("d1", FOO, "Foo#kept", [1, 3]), deltaRow("d2", FOO, "Foo#renamedMethod", [5, 9])],
    });

    // Inheritance stays where the base holds the symbol; the file block is the base's.
    expect(rows[0].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(4) });
    expect(rows[1].payload.git).toEqual({ file: GIT_FILE, chunk: onDemandChunk(5) });
    expect(gitSignals.signalsOf).toHaveBeenCalledWith(
      TREE.root,
      [
        {
          relativePath: FOO,
          treePath: FOO,
          maxEndLine: 9,
          fileLines: 9,
          fileSignals: false,
          chunks: [{ key: "d2", startLine: 5, endLine: 9 }],
        },
      ],
      undefined,
      TREE.baseIndex.root,
    );
  });

  // Round-4 P3 (parity harness): `git.file.relativeChurn` is churn over the
  // file's line count — ingest's `maxEndLine` over the file's chunks — and a
  // reindex of the tree recomputes it over the TREE file's rows. An inherited
  // block keeps the base's history and takes the tree's line count.
  it("rescales an inherited git.file's relativeChurn to the tree file's rows, as a reindex recomputes it", async () => {
    const churned = { ...GIT_FILE, linesAdded: 30, linesDeleted: 10, relativeChurn: 4 };
    const point = basePoint("b1", FOO, "Foo#kept", 4);
    const source = sourceWith([
      { ...point, payload: { ...point.payload, git: { file: churned, chunk: gitChunk(4) } } },
    ]);

    const { rows } = await source.enrich({
      tree: TREE,
      rows: [deltaRow("d1", FOO, "Foo#kept", [1, 3]), deltaRow("d2", FOO, "Foo#more", [5, 20])],
    });

    // 40 changed rows over 20 → 2; every other key is the base's.
    expect(rows[0].payload.git).toEqual({ file: { ...churned, relativeChurn: 2 }, chunk: gitChunk(4) });
    expect(rows[1].payload.git).toEqual({ file: { ...churned, relativeChurn: 2 } });
  });

  // Invariant changed (live G4): a brand-new symbol in a tracked, modified file
  // gets the chunk walk's zero block — what ingest writes for a chunk no commit
  // touched — not "no block". Real git: the port's answer is the invariant.
  it("gives a brand-new symbol in a tracked file the chunk walk's zero block", async () => {
    const fixture = createGitWorkingTreeFixture();
    try {
      fixture.commit(fixture.mainRoot, { [FOO]: "export function kept(): number {\n  return 1;\n}\n" }, "add foo");
      appendFileSync(join(fixture.mainRoot, FOO), "\nexport function brandNew(): number {\n  return 2;\n}\n");
      const source = sourceWith(
        [basePoint("b1", FOO, "Foo#kept", 4)],
        createWorkingTreeGitSignalSource({
          vcsAdapter: "git",
          timeoutMs: 30_000,
          chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
        }),
      );

      const { rows } = await source.enrich({
        tree: { ...TREE, root: fixture.mainRoot },
        rows: [deltaRow("d1", FOO, "Foo#kept", [1, 3]), deltaRow("d2", FOO, "Foo#brandNew", [5, 7])],
      });

      expect(rows[0].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(4) });
      expect(rows[1].payload.git).toEqual({
        file: GIT_FILE,
        chunk: expect.objectContaining({ commitCount: 0, lastModifiedAt: 0, blameDominantAuthor: "unknown" }),
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("asks for the old path, reading lines from the new one, when a renamed file's old path has no base point", async () => {
    const gitSignals = answering({ [OLD]: { file: ON_DEMAND_FILE, chunks: { d1: onDemandChunk(1) } } });
    const source = sourceWith([basePoint("b1", FOO, "Foo#kept", 4)], gitSignals);

    const { rows } = await source.enrich({
      tree: TREE,
      rows: [deltaRow("d1", NEW, "x", [1, 9])],
      renamedFrom: new Map([[NEW, OLD]]),
    });

    expect(rows[0].payload.git).toEqual({ file: ON_DEMAND_FILE, chunk: onDemandChunk(1) });
    expect(gitSignals.signalsOf).toHaveBeenCalledWith(
      TREE.root,
      [
        {
          relativePath: OLD,
          treePath: NEW,
          maxEndLine: 9,
          fileLines: 9,
          fileSignals: true,
          chunks: [{ key: "d1", startLine: 1, endLine: 9 }],
        },
      ],
      undefined,
      TREE.baseIndex.root,
    );
  });

  it("keeps no git block for a file with no history at all", async () => {
    const gitSignals = answering({});
    const source = sourceWith([basePoint("b1", FOO, "Foo#kept", 4)], gitSignals);

    const { rows } = await source.enrich({ tree: TREE, rows: [deltaRow("d1", "src/untracked.ts", "fresh")] });

    expect(rows[0].payload).not.toHaveProperty("git");
  });

  // Live round-3 D4: ingest gives an untracked file's chunks the walk's zero
  // overlay (and `git.file` only its run stamp, no signal), so the tree's rows
  // carry the chunk block the on-demand walk answers — never nothing.
  it("gives an untracked file's rows the chunk block the on-demand walk answers, without a git.file", async () => {
    const zero = { commitCount: 0, churnRatio: 0, blameDominantAuthor: "unknown" };
    const gitSignals = answering({ "src/untracked.ts": { chunks: { d1: zero } } });
    const source = sourceWith([basePoint("b1", FOO, "Foo#kept", 4)], gitSignals);

    const { rows } = await source.enrich({ tree: TREE, rows: [deltaRow("d1", "src/untracked.ts", "fresh")] });

    expect(rows[0].payload.git).toEqual({ chunk: zero });
  });

  it("asks nothing when the base index carries no git at all", async () => {
    const gitSignals = answering({ [SMALL]: { file: ON_DEMAND_FILE } });
    const noGit = basePoint("b1", FOO, "Foo#kept", 4);
    delete (noGit.payload as Record<string, unknown>).git;
    const source = sourceWith([noGit], gitSignals);

    const { rows } = await source.enrich({ tree: TREE, rows: [deltaRow("d1", SMALL, "c", [1, 3])] });

    expect(rows[0].payload).not.toHaveProperty("git");
    expect(gitSignals.signalsOf).not.toHaveBeenCalled();
  });

  it("keeps the rows when the on-demand source fails", async () => {
    const source = sourceWith([basePoint("b1", FOO, "Foo#kept", 4)], {
      signalsOf: async () => {
        throw new Error("git exploded");
      },
      pathsCommittedSince: async () => undefined,
    });

    const { rows } = await source.enrich({
      tree: TREE,
      rows: [deltaRow("d1", SMALL, "c", [1, 3]), deltaRow("d2", FOO, "Foo#kept")],
    });

    expect(rows[0].payload).not.toHaveProperty("git");
    expect(rows[1].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(4) });
  });

  /**
   * Live G1: a file a COMMIT touched after the index has history its base
   * points never saw — inheriting them ranked a just-committed test file as 196
   * days old. Its git is recomputed from the tree's real history, every row of
   * it; a file changed only by uncommitted edits keeps inheriting (an
   * uncommitted edit is not a commit). The committed set is asked once per
   * request.
   */
  describe("a file whose history moved since the index", () => {
    const INDEXED = "a".repeat(40);
    const fresh = { commitCount: 41, lastModifiedAt: 1_790_000_000, ageDays: 0 };

    it("recomputes git.file and every row's git.chunk instead of inheriting them", async () => {
      const gitSignals = answering(
        { [FOO]: { file: fresh, chunks: { d1: onDemandChunk(12), d2: onDemandChunk(1) } } },
        [FOO, "src/elsewhere.ts"],
      );
      const source = sourceWith([basePoint("b1", FOO, "Foo#kept", 4), basePoint("b2", SMALL, "c", 3)], gitSignals);

      const { rows } = await source.enrich({
        tree: TREE,
        indexedCommit: INDEXED,
        rows: [
          deltaRow("d1", FOO, "Foo#kept", [1, 3]),
          deltaRow("d2", FOO, "Foo#other", [5, 6]),
          deltaRow("d3", SMALL, "c", [1, 3]),
        ],
      });

      expect(rows[0].payload.git).toEqual({ file: fresh, chunk: onDemandChunk(12) });
      expect(rows[1].payload.git).toEqual({ file: fresh, chunk: onDemandChunk(1) });
      // Changed only by uncommitted edits: the base's history still holds.
      expect(rows[2].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(3) });
      expect(gitSignals.pathsCommittedSince).toHaveBeenCalledTimes(1);
      expect(gitSignals.pathsCommittedSince).toHaveBeenCalledWith(TREE.root, INDEXED);
      expect(gitSignals.signalsOf).toHaveBeenCalledWith(
        TREE.root,
        [
          {
            relativePath: FOO,
            treePath: FOO,
            maxEndLine: 6,
            fileLines: 6,
            fileSignals: true,
            chunks: [
              { key: "d1", startLine: 1, endLine: 3 },
              { key: "d2", startLine: 5, endLine: 6 },
            ],
          },
        ],
        INDEXED,
        TREE.baseIndex.root,
      );
    });

    // Live C1: a row carries the same git blocks whichever batch enriched it.
    it("gives each file's rows the git blocks enriching the whole delta gives them", async () => {
      const gitSignals = answering(
        { [FOO]: { file: fresh, chunks: { d1: onDemandChunk(12) } }, [SMALL]: { chunks: { d3: onDemandChunk(2) } } },
        [FOO],
      );
      const source = sourceWith([basePoint("b2", SMALL, "c", 3)], gitSignals);
      const rows = [deltaRow("d1", FOO, "Foo#kept", [1, 3]), deltaRow("d3", SMALL, "fresh", [5, 6])];

      const whole = await source.enrich({ tree: TREE, indexedCommit: INDEXED, rows });
      const alone = await Promise.all(
        rows.map(async (row) => source.enrich({ tree: TREE, indexedCommit: INDEXED, rows: [row] })),
      );

      expect(alone.map((result) => result.rows[0])).toEqual(whole.rows);
      expect(whole.rows.map((row) => row.payload.git)).toEqual([
        { file: fresh, chunk: onDemandChunk(12) },
        { file: GIT_FILE, chunk: onDemandChunk(2) },
      ]);
      // The stamp reaches the git source, which keys a file's record by its own history.
      expect(gitSignals.signalsOf.mock.calls.every((call) => call[2] === INDEXED)).toBe(true);
    });

    it("recomputes a file moved by a commit at its new path, whose history follows the move", async () => {
      const gitSignals = answering({ [NEW]: { file: fresh, chunks: { d1: onDemandChunk(8) } } }, [OLD, NEW]);
      const source = sourceWith([basePoint("b1", OLD, "Foo#kept", 7)], gitSignals);

      const { rows } = await source.enrich({
        tree: TREE,
        indexedCommit: INDEXED,
        rows: [deltaRow("d1", NEW, "Foo#kept", [1, 3])],
        renamedFrom: new Map([[NEW, OLD]]),
      });

      expect(rows[0].payload.git).toEqual({ file: fresh, chunk: onDemandChunk(8) });
      expect(gitSignals.signalsOf).toHaveBeenCalledWith(
        TREE.root,
        [
          {
            relativePath: NEW,
            treePath: NEW,
            maxEndLine: 3,
            fileLines: 3,
            fileSignals: true,
            chunks: [{ key: "d1", startLine: 1, endLine: 3 }],
          },
        ],
        INDEXED,
        TREE.baseIndex.root,
      );
    });

    // Live G1 on a diverged HEAD: a linked worktree branched from an OLDER main
    // while the index sits at a NEWER main tip. A file only the stamp's side
    // touched is in the delta, and its base history holds commits the tree
    // does not have — inheriting it would date the tree's code by main's.
    it("recomputes a file only commits the tree lacks touched, from the tree's own history", async () => {
      const fixture = createGitWorkingTreeFixture();
      try {
        const v1 = "export function kept(): number {\n  return 1;\n}\n";
        fixture.commit(fixture.mainRoot, { [FOO]: v1 }, "add foo");
        fixture.commit(fixture.mainRoot, { [FOO]: v1.replace("1;", "2;") }, "fix: foo");
        const tree = fixture.addWorktree("old");
        fixture.commit(tree, { "src/other.ts": "export const o = 1;\n" }, "branch work");
        const stamp = fixture.commit(fixture.mainRoot, { [FOO]: v1.replace("1;", "3;") }, "main moves foo");
        const source = sourceWith(
          [{ ...basePoint("b1", FOO, "Foo#kept", 4), payload: { ...basePoint("b1", FOO, "Foo#kept", 4).payload } }],
          createWorkingTreeGitSignalSource({
            vcsAdapter: "git",
            timeoutMs: 30_000,
            chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
          }),
        );

        const { rows } = await source.enrich({
          tree: { ...TREE, root: tree },
          indexedCommit: stamp,
          rows: [deltaRow("d1", FOO, "Foo#kept", [1, 3])],
        });

        // The branch holds "init", "add foo", "fix: foo" for foo — two commits, never main's third.
        const git = rows[0].payload.git as { file: Record<string, unknown>; chunk: Record<string, unknown> };
        expect(git.file).toMatchObject({ commitCount: 2 });
        expect(git.file).not.toEqual(GIT_FILE);
        expect(git.chunk).toMatchObject({ commitCount: 2 });
      } finally {
        fixture.cleanup();
      }
    });

    it("keeps inheriting when git cannot say what was committed, or the index has no stamp", async () => {
      const unknown = answering({ [FOO]: { file: fresh } }, undefined);
      const stampless = answering({ [FOO]: { file: fresh } }, [FOO]);

      const [a, b] = await Promise.all([
        sourceWith([basePoint("b1", FOO, "Foo#kept", 4)], unknown).enrich({
          tree: TREE,
          indexedCommit: INDEXED,
          rows: [deltaRow("d1", FOO, "Foo#kept")],
        }),
        sourceWith([basePoint("b1", FOO, "Foo#kept", 4)], stampless).enrich({
          tree: TREE,
          rows: [deltaRow("d1", FOO, "Foo#kept")],
        }),
      ]);

      expect(a.rows[0].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(4) });
      expect(b.rows[0].payload.git).toEqual({ file: GIT_FILE, chunk: gitChunk(4) });
      expect(stampless.pathsCommittedSince).not.toHaveBeenCalled();
    });
  });
});
