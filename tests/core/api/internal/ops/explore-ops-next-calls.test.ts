/**
 * ExploreOps — `next` expansion hints and the lean default payload on the read
 * path (agent turn economy N4 + N5, bd tea-rags-mcp-r4rl1).
 *
 * `next` rides on hybrid_search / semantic_search answers only, only when
 * codegraph is wired (the gate the find_symbol `codegraphWarning` reads), and
 * its args name the tree that answered. The default projection runs last, so
 * the anchors are chosen from the full rows even when the payload is narrowed.
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
      driftReporter: {
        checkAndConsume: vi.fn().mockResolvedValue(null),
        checkAndConsumeByCollectionName: vi.fn().mockReturnValue(null),
      } as any,
      payloadSignals: LOCATOR_SIGNALS,
      essentialKeys: [],
      workingTreeOverlay: stubOverlay(),
      ...(codegraph ? { chunkResolver: { resolveSymbolChunk: vi.fn().mockResolvedValue(null) } } : {}),
    });

  for (const tool of ["hybrid_search", "semantic_search"] as const) {
    const call = async (f: ExploreFacade, extra: Record<string, unknown> = {}) =>
      tool === "hybrid_search"
        ? f.hybridSearch({ collection: "code_x", query: "q", ...extra })
        : f.semanticSearch({ collection: "code_x", query: "q", ...extra });

    it(`${tool}: codegraph on → co-change + callers hints addressed to the answering tree`, async () => {
      const response = await call(makeFacade(HITS));

      expect(response.next).toEqual([
        expect.objectContaining({
          tool: "find_co_changed",
          args: { project: "tea-rags", path: MARKER.tree, files: ["src/a.ts", "src/b.ts"] },
        }),
        expect.objectContaining({
          tool: "get_callers",
          args: { project: "tea-rags", path: MARKER.tree, relativePath: "src/a.ts" },
        }),
      ]);
    });

    it(`${tool}: anchors are chosen from the full rows even when fields drops relativePath`, async () => {
      const response = await call(makeFacade(HITS), { fields: ["symbolId"] });

      expect(response.next?.[0]?.args.files).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it(`${tool}: codegraph off → no next`, async () => {
      const response = await call(makeFacade(HITS, { codegraph: false }));

      expect(response).not.toHaveProperty("next");
    });

    it(`${tool}: empty answer → no next`, async () => {
      const response = await call(makeFacade([]));

      expect(response).not.toHaveProperty("next");
    });
  }

  it("find_symbol answers carry no next", async () => {
    const response = await makeFacade(HITS).findSymbol({ collection: "code_x", symbol: "aFn" });

    expect(response).not.toHaveProperty("next");
  });

  it("hybrid_search metaOnly without rerank → payload is the locator with its signature", async () => {
    const response = await makeFacade(HITS).hybridSearch({ collection: "code_x", query: "q", metaOnly: true });

    expect(response.results[0]?.payload).toEqual({
      relativePath: "src/a.ts",
      symbolId: "aFn",
      startLine: 1,
      endLine: 9,
      chunkType: "function",
      language: "typescript",
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
});
