/**
 * Strategies without a floor (bd tea-rags-mcp-xi2r9.3): base rows of delta
 * files stay in the answer and carry `treeState` on the result — "deleted" for
 * a file gone from the tree, "modified" for any other delta file. Hiding them
 * would make a modified file vanish from semantic_search until the dense floor
 * ships. Stamped once in `BaseExploreStrategy`, never per strategy.
 */

import { describe, expect, it, vi } from "vitest";

import { fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { ScrollRankStrategy } from "../../../../../src/core/domains/explore/strategies/scroll-rank.js";
import type { ExploreContext } from "../../../../../src/core/domains/explore/strategies/types.js";
import { VectorSearchStrategy } from "../../../../../src/core/domains/explore/strategies/vector.js";

const ROWS = [
  { id: "m", score: 0.9, payload: { relativePath: "src/modified.ts", methodLines: 10 } },
  { id: "d", score: 0.8, payload: { relativePath: "src/deleted.ts", methodLines: 20 } },
  { id: "u", score: 0.7, payload: { relativePath: "src/untouched.ts", methodLines: 30 } },
];

const VIEW = fakeWorkingTreeView({ changed: ["src/modified.ts"], deleted: ["src/deleted.ts"] });

const METHOD_LINES: PayloadSignalDescriptor = { key: "methodLines", type: "number", description: "lines" };

async function vectorRun(ctx: Partial<ExploreContext>) {
  const qdrant = { search: vi.fn().mockResolvedValue(ROWS) } as unknown as QdrantManager;
  const reranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;
  return new VectorSearchStrategy(qdrant, reranker, [], []).execute({
    collectionName: "c",
    embedding: [0.1],
    limit: 10,
    ...ctx,
  });
}

async function rankRun(ctx: Partial<ExploreContext>) {
  const qdrant = {
    scrollOrdered: vi.fn().mockResolvedValue(ROWS.map(({ id, payload }) => ({ id, payload }))),
    ensurePayloadIndex: vi.fn().mockResolvedValue(true),
  } as unknown as QdrantManager;
  const reranker = {
    rerank: vi.fn((r: { id: string }[]) => r.map((x, i) => ({ ...x, score: 1 - i * 0.1 }))),
    getDescriptors: vi
      .fn()
      .mockReturnValue([
        { name: "chunkSize", description: "s", sources: ["methodLines"], defaultBound: 1, extract: () => 1 },
      ]),
    getPreset: vi.fn().mockReturnValue({ chunkSize: 1 }),
    getFullPreset: vi.fn().mockReturnValue(undefined),
  } as unknown as Reranker;
  return new ScrollRankStrategy(qdrant, reranker, [METHOD_LINES], []).execute({
    collectionName: "c",
    limit: 10,
    weights: { chunkSize: 1 },
    ...ctx,
  });
}

const stateById = (results: { id?: string | number; treeState?: string }[]) =>
  Object.fromEntries(results.map((r) => [r.id, r.treeState]));

describe("treeState on strategies without a floor", () => {
  it("stamps semantic_search rows of delta files", async () => {
    const results = await vectorRun({ workingTreeView: VIEW });

    expect(stateById(results)).toEqual({ m: "modified", d: "deleted", u: undefined });
    expect(results.find((r) => r.id === "u")).not.toHaveProperty("treeState");
  });

  it("stamps rank_chunks rows of delta files", async () => {
    const results = await rankRun({ workingTreeView: VIEW });

    expect(stateById(results)).toEqual({ m: "modified", d: "deleted", u: undefined });
  });

  it("puts treeState on the result, never inside the payload", async () => {
    const results = await vectorRun({ workingTreeView: VIEW, metaOnly: true });

    expect(results.find((r) => r.id === "m")?.treeState).toBe("modified");
    expect(results.every((r) => !("treeState" in (r.payload ?? {})))).toBe(true);
  });

  it("changes nothing when the view touches no path", async () => {
    const without = await vectorRun({});
    const withView = await vectorRun({ workingTreeView: fakeWorkingTreeView({}) });

    expect(JSON.stringify(withView)).toBe(JSON.stringify(without));
  });
});
