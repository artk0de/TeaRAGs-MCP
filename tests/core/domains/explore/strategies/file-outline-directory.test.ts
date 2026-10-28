/**
 * FileOutlineStrategy directory mode (agent turn economy N2): a `relativePath`
 * that names no indexed file but prefixes indexed files answers with one level
 * of the directory — its files with their top-level symbols, its subdirectories
 * with file counts — read from the index under the working-tree overlay. A path
 * that names neither explains itself with the nearest indexed paths.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import { FileOutlineStrategy } from "../../../../../src/core/domains/explore/strategies/file-outline.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

describe("FileOutlineStrategy directory mode", () => {
  const mockScrollFiltered = vi.fn();
  const qdrant = { scrollFiltered: mockScrollFiltered } as any;
  const reranker = { rerank: vi.fn((r: any[]) => r) } as any;

  /** The index: a word-tokenized text index on relativePath, value match on the rest. */
  const indexHolds = (rows: ScrollChunk[]) => {
    mockScrollFiltered.mockImplementation(async (_c: string, filter: { must: any[] }) =>
      rows.filter((row) =>
        filter.must.every(({ key, match }) => {
          const raw = row.payload[key];
          const value = typeof raw === "string" ? raw : "";
          if (match.text !== undefined) {
            const have = new Set(tokens(value));
            return tokens(match.text).every((t) => have.has(t));
          }
          return value === match.value;
        }),
      ),
    );
  };

  const fn = (id: string, relativePath: string, symbolId: string, extra: Record<string, unknown> = {}) =>
    codeRow(id, { relativePath, symbolId, name: symbolId, ...extra });

  const strategyFor = (relativePath: string) => new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath });
  const run = async (strategy: FileOutlineStrategy, view?: WorkingTreeView) =>
    strategy.execute({ collectionName: "c", limit: 1, ...(view ? { workingTreeView: view } : {}) });

  const DIR = "src/strategies";
  const index = [
    fn("a1", `${DIR}/base.ts`, "BaseStrategy", { chunkType: "class", startLine: 1 }),
    codeRow("a2", {
      relativePath: `${DIR}/base.ts`,
      symbolId: "BaseStrategy#run",
      name: "run",
      parentSymbolId: "BaseStrategy",
      startLine: 5,
    }),
    fn("b1", `${DIR}/vector.ts`, "VectorStrategy", { startLine: 1 }),
    codeRow("b2", { relativePath: `${DIR}/vector.ts`, chunkType: "block", startLine: 30 }),
    fn("c1", `${DIR}/deep/inner.ts`, "inner"),
    fn("c2", `${DIR}/deep/more/other.ts`, "other"),
    fn("d1", "src/strategies-legacy/old.ts", "old"),
    fn("e1", "src/other/base.ts", "otherBase"),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the exact-file outline unchanged", async () => {
    indexHolds(index);
    const strategy = strategyFor(`${DIR}/vector.ts`);

    const results = await run(strategy);

    expect(results).toHaveLength(1);
    expect(results[0].payload?.content).toBe(`${DIR}/vector.ts\n  VectorStrategy`);
    expect(strategy.directory).toBeUndefined();
  });

  it("answers a directory with its files, their top-level symbols and its subdirectories", async () => {
    indexHolds(index);
    const strategy = strategyFor(DIR);

    const results = await run(strategy);

    expect(results.map((r) => r.payload)).toEqual([
      { relativePath: `${DIR}/base.ts`, language: "typescript", symbols: ["BaseStrategy"] },
      { relativePath: `${DIR}/vector.ts`, language: "typescript", symbols: ["VectorStrategy"] },
    ]);
    expect(strategy.directory).toEqual({
      kind: "directory",
      dir: DIR,
      subdirs: [{ dir: `${DIR}/deep`, fileCount: 2 }],
      total: 2,
      truncated: false,
    });
    expect(strategy.emptyAnswer).toBeUndefined();
  });

  it("scrolls the directory without chunk content", async () => {
    indexHolds(index);

    await run(strategyFor(DIR));

    const payloadInclude = mockScrollFiltered.mock.calls.at(-1)?.[4] as string[] | undefined;
    expect(payloadInclude).toBeDefined();
    expect(payloadInclude).not.toContain("content");
  });

  it("accepts a trailing slash", async () => {
    indexHolds(index);
    const strategy = strategyFor(`${DIR}/`);

    const results = await run(strategy);

    expect(results).toHaveLength(2);
    expect(strategy.directory?.dir).toBe(DIR);
  });

  it("caps the top-level symbols of a file at 8 plus a remainder", async () => {
    indexHolds(Array.from({ length: 11 }, (_, i) => fn(`f${i}`, `${DIR}/many.ts`, `fn${i}`, { startLine: i * 10 })));

    const results = await run(strategyFor(DIR));

    expect(results[0].payload?.symbols).toEqual([...Array.from({ length: 8 }, (_, i) => `fn${i}`), "+3 more"]);
  });

  it("truncates at 50 files and reports the total", async () => {
    indexHolds(Array.from({ length: 51 }, (_, i) => fn(`f${i}`, `${DIR}/f${String(i).padStart(2, "0")}.ts`, `f${i}`)));
    const strategy = strategyFor(DIR);

    const results = await run(strategy);

    expect(results).toHaveLength(50);
    expect(strategy.directory).toMatchObject({ total: 51, truncated: true });
  });

  it("explains an unknown path with same-basename files first, then files under the nearest ancestor", async () => {
    indexHolds(index);
    const strategy = strategyFor("src/strategies/nested/base.ts");

    const results = await run(strategy);

    expect(results).toEqual([]);
    expect(strategy.directory).toBeUndefined();
    expect(strategy.emptyAnswer).toEqual({
      reason: "unknownPath",
      message: expect.stringContaining("src/strategies/nested/base.ts"),
      suggestions: [
        `${DIR}/base.ts`,
        "src/other/base.ts",
        `${DIR}/deep/inner.ts`,
        `${DIR}/deep/more/other.ts`,
        `${DIR}/vector.ts`,
      ],
    });
  });

  describe("on a linked working tree", () => {
    it("lists an added file with its tree symbols", async () => {
      indexHolds(index);
      const added = fn("n1", `${DIR}/added.ts`, "AddedStrategy");
      const view = fakeWorkingTreeView({ changed: [`${DIR}/added.ts`], rows: [added] });

      const results = await run(strategyFor(DIR), view);

      expect(results.map((r) => r.payload?.relativePath)).toContain(`${DIR}/added.ts`);
      expect(results.find((r) => r.payload?.relativePath === `${DIR}/added.ts`)?.payload?.symbols).toEqual([
        "AddedStrategy",
      ]);
      expect(view.marker.floors).toContain("chunks");
    });

    it("excludes a deleted file", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({ deleted: [`${DIR}/vector.ts`], rows: [] });

      const results = await run(strategyFor(DIR), view);

      expect(results.map((r) => r.payload?.relativePath)).toEqual([`${DIR}/base.ts`]);
    });

    it("shows the tree's symbols of a modified file", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({
        changed: [`${DIR}/vector.ts`],
        rows: [fn("v-new", `${DIR}/vector.ts`, "RenamedVectorStrategy")],
      });

      const results = await run(strategyFor(DIR), view);

      expect(results.find((r) => r.payload?.relativePath === `${DIR}/vector.ts`)?.payload?.symbols).toEqual([
        "RenamedVectorStrategy",
      ]);
    });

    it("lists a signalled tree file without its trajectory blocks", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({
        changed: [`${DIR}/vector.ts`],
        rows: [fn("v-new", `${DIR}/vector.ts`, "VectorStrategy")],
      });
      view.signalDeltaRows = async (rows) =>
        rows.map((row) => ({ ...row, payload: { ...row.payload, git: { file: { commitCount: 1 } } } }));

      const results = await run(strategyFor(DIR), view);

      expect(results.find((r) => r.payload?.relativePath === `${DIR}/vector.ts`)?.payload).toEqual({
        relativePath: `${DIR}/vector.ts`,
        language: "typescript",
        symbols: ["VectorStrategy"],
      });
    });

    it("marks a pending file's row with treeState and keeps the index symbols", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({ indexServed: [`${DIR}/vector.ts`], rows: [] });

      const results = await run(strategyFor(DIR), view);

      const row = results.find((r) => r.payload?.relativePath === `${DIR}/vector.ts`);
      expect(row?.treeState).toBe("modified");
      expect(row?.payload?.symbols).toEqual(["VectorStrategy"]);
    });

    it("suggests an added file and never a deleted one for an unknown path", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({
        changed: [`${DIR}/nested/base.ts`.replace("nested/", "fresh/")],
        deleted: [`${DIR}/base.ts`],
        rows: [fn("n1", `${DIR}/fresh/base.ts`, "FreshBase")],
      });
      const strategy = strategyFor("src/strategies/nested/base.ts");

      await run(strategy, view);

      expect(strategy.emptyAnswer?.suggestions?.[0]).toBe(`${DIR}/fresh/base.ts`);
      expect(strategy.emptyAnswer?.suggestions).not.toContain(`${DIR}/base.ts`);
    });

    // bd tea-rags-mcp-d9w4o: a path the tree has but ingest ignores is not unknown.
    it("explains a tree file an ignore pattern excludes as ignoredPath naming the pattern", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({
        unindexed: { "db/migrate/001_create.rb": { isDirectory: false, ignoreRule: "db/migrate/" } },
      });
      const strategy = strategyFor("db/migrate/001_create.rb");

      const results = await run(strategy, view);

      expect(results).toEqual([]);
      expect(strategy.emptyAnswer).toEqual({
        reason: "ignoredPath",
        message:
          '"db/migrate/001_create.rb" exists in the working tree but is not indexed (ignore pattern "db/migrate/") — ' +
          "read it with the default code read tool.",
      });
    });

    it("explains an excluded tree directory as ignoredPath pointing at the default code tools", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({ unindexed: { "db/migrate": { isDirectory: true } } });
      const strategy = strategyFor("db/migrate/");

      await run(strategy, view);

      expect(strategy.emptyAnswer).toEqual({
        reason: "ignoredPath",
        message:
          'directory "db/migrate" exists in the working tree but is not indexed — ' +
          "list and read it with the default code search / read tools.",
      });
    });

    it("keeps unknownPath for a path the tree does not have either", async () => {
      indexHolds(index);
      const view = fakeWorkingTreeView({ unindexed: {} });
      const strategy = strategyFor("src/strategies/nested/base.ts");

      await run(strategy, view);

      expect(strategy.emptyAnswer?.reason).toBe("unknownPath");
    });
  });
});
