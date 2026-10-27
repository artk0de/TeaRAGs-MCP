/**
 * ExploreOps — no `next` expansion hints (N5 retired, bd tea-rags-mcp-icujw) and
 * the lean default payload on the read path (agent turn economy N4, bd
 * tea-rags-mcp-r4rl1). Pagination's `truncated.next` is the response budget's,
 * not tested here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";
import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

vi.mock("../../../../../src/core/domains/explore/rank-module.js", () => ({
  RankModule: class {
    rankChunks = vi.fn().mockResolvedValue([]);
  },
}));

const MARKER: WorkingTreeMarker = {
  tree: "/repo/.claude/worktrees/feature",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 1,
  deletedFiles: 0,
  floors: [],
  project: "tea-rags",
};

const point = (id: string, score: number, relativePath: string, extra: Record<string, unknown> = {}) => ({
  id,
  score,
  payload: {
    relativePath,
    language: "typescript",
    symbolId: `${id}Fn`,
    startLine: 1,
    endLine: 9,
    chunkType: "function",
    content: `/** doc */\nexport function ${id}Fn() {\n  return 1;\n}`,
    imports: ["./x.js"],
    git: { file: { commitCount: 4, taskIds: ["tea-rags-mcp-a"] } },
    ...extra,
  },
});

const HITS = [point("a", 0.9, "src/a.ts"), point("b", 0.8, "src/b.ts")];

const LOCATOR_SIGNALS = ["relativePath", "language", "symbolId", "startLine", "endLine", "chunkType"].map(
  (key) => ({ key, type: "string", description: key }) as unknown as PayloadSignalDescriptor,
);

function makeQdrant(results: unknown[]) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue(results),
    queryGroups: vi.fn().mockResolvedValue(results),
    hybridSearch: vi.fn().mockResolvedValue(results),
    query: vi.fn().mockResolvedValue(results),
    scrollFiltered: vi.fn().mockResolvedValue(results),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
    getPoint: vi.fn().mockResolvedValue(null),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeReranker() {
  return {
    hasCollectionStatsFor: vi.fn().mockReturnValue(false),
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
  } as any;
}

function makeTrajectoryRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, raw?: any) => raw),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

function stubOverlay() {
  const view: WorkingTreeView = { marker: MARKER, touchedPaths: new Set(), deletedPaths: new Set() };
  return { view: vi.fn().mockResolvedValue(view) };
}

describe("ExploreOps — next expansion hints (N5) and lean default payload (N4)", () => {
  let registryDir: string;
  let collectionRegistry: CollectionRegistry;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), "explore-next-registry-"));
    collectionRegistry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  const makeFacade = (results: unknown[], { codegraph = true } = {}) =>
    new ExploreFacade({
      qdrant: makeQdrant(results),
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1] }) } as any,
      reranker: makeReranker(),
      registry: makeTrajectoryRegistry(),
      collectionRegistry,
      payloadSignals: LOCATOR_SIGNALS,
      essentialKeys: [],
      workingTreeOverlay: stubOverlay(),
      ...(codegraph ? { chunkResolver: { resolveSymbolChunk: vi.fn().mockResolvedValue(null) } } : {}),
    });

  // PIN-UPDATED icujw: `next` expansion hints left every read answer — a benchmark
  // carried them on 18/43 answers (11.2k chars) and the agent followed 0. Codegraph
  // on, rows with anchors, every mode: the answer names no next call.
  for (const tool of ["hybrid_search", "semantic_search"] as const) {
    it(`${tool}: codegraph on, anchored rows → no next`, async () => {
      const facade = makeFacade(HITS);
      const response =
        tool === "hybrid_search"
          ? await facade.hybridSearch({ collection: "code_x", query: "q" })
          : await facade.semanticSearch({ collection: "code_x", query: "q" });

      expect(response).not.toHaveProperty("next");
    });
  }

  describe("find_symbol — codegraph on, no mode carries next", () => {
    it.each([
      ["relativePath", { relativePath: "src/a.ts" }],
      ["symbol", { symbol: "run" }],
      ["symbols batch", { symbols: ["tFn", "aFn", "bFn"] }],
    ])("%s → no next", async (_mode, address) => {
      const response = await makeFacade(HITS).findSymbol({ collection: "code_x", ...address });

      expect(response).not.toHaveProperty("next");
    });
  });

  // PIN-UPDATED q1g6s.16: the metaOnly search default is DEFAULT_META_ONLY_FIELDS — chunkType / language left the row.
  it("hybrid_search metaOnly without rerank → payload is the locator with its signature", async () => {
    const response = await makeFacade(HITS).hybridSearch({ collection: "code_x", query: "q", metaOnly: true });

    expect(response.results[0]?.payload).toEqual({
      relativePath: "src/a.ts",
      symbolId: "aFn",
      startLine: 1,
      endLine: 9,
      signature: "export function aFn() {",
    });
  });

  it("hybrid_search with content → locator + content, no raw git / imports", async () => {
    const response = await makeFacade(HITS).hybridSearch({ collection: "code_x", query: "q" });
    const payload = response.results[0]?.payload ?? {};

    expect(payload.content).toContain("export function aFn()");
    expect(payload).not.toHaveProperty("git");
    expect(payload).not.toHaveProperty("imports");
  });

  it("semantic_search content default is exactly DEFAULT_SEARCH_FIELDS (q1g6s.16)", async () => {
    const response = await makeFacade(HITS).semanticSearch({ collection: "code_x", query: "q" });

    expect(Object.keys(response.results[0]?.payload ?? {})).toEqual([
      "relativePath",
      "symbolId",
      "startLine",
      "endLine",
      "content",
    ]);
  });

  it("find_symbol keeps its own lean default — chunkType stays (q1g6s.16 scope)", async () => {
    const response = await makeFacade(HITS).findSymbol({ collection: "code_x", symbol: "aFn", metaOnly: true });

    expect(response.results[0]?.payload).toHaveProperty("chunkType", "function");
  });
});
