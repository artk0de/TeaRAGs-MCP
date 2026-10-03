/**
 * rank_chunks on a working tree (bd tea-rags-mcp-xi2r9, WTO-5): signal-only
 * rankings read the tree too. The base rows of every file the tree changed or
 * deleted leave the candidate pool, and the tree's rows of those files — with
 * the signals the delta-signal source gave them — join it before the rerank,
 * held to the request filter and the exact pathPattern like the scroll was.
 */

import { describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { ScrollRankStrategy } from "../../../../../src/core/domains/explore/strategies/scroll-rank.js";
import type { ExploreContext } from "../../../../../src/core/domains/explore/strategies/types.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

const TOUCHED = "src/modified.ts";
const GONE = "src/deleted.ts";

const SCROLLED = [
  { id: "m", payload: { relativePath: TOUCHED, language: "typescript", methodLines: 10 } },
  { id: "d", payload: { relativePath: GONE, language: "typescript", methodLines: 20 } },
  { id: "u", payload: { relativePath: "src/untouched.ts", language: "typescript", methodLines: 30 } },
];

const METHOD_LINES: PayloadSignalDescriptor = { key: "methodLines", type: "number", description: "lines" };

/** Ranks by methodLines, largest first — what the preset would compute. */
const reranker = {
  rerank: vi.fn((r: { id: string; payload: { methodLines?: number } }[]) =>
    [...r]
      .sort((a, b) => (b.payload.methodLines ?? 0) - (a.payload.methodLines ?? 0))
      .map((x, i) => ({ ...x, score: 1 - i * 0.1 })),
  ),
  getDescriptors: vi
    .fn()
    .mockReturnValue([
      { name: "chunkSize", description: "s", sources: ["methodLines"], defaultBound: 1, extract: () => 1 },
    ]),
  getPreset: vi.fn().mockReturnValue({ chunkSize: 1 }),
  getFullPreset: vi.fn().mockReturnValue(undefined),
} as unknown as Reranker;

async function rank(view: WorkingTreeView | undefined, ctx: Partial<ExploreContext> = {}) {
  const qdrant = {
    scrollOrdered: vi.fn().mockResolvedValue(SCROLLED),
    ensurePayloadIndex: vi.fn().mockResolvedValue(true),
  } as unknown as QdrantManager;
  return new ScrollRankStrategy(qdrant, reranker, [METHOD_LINES], []).execute({
    collectionName: "c",
    limit: 10,
    weights: { chunkSize: 1 },
    ...(view ? { workingTreeView: view } : {}),
    ...ctx,
  });
}

const treeRow = codeRow("t-big", { relativePath: TOUCHED, methodLines: 99 });
const treeView = (rows = [treeRow]) => fakeWorkingTreeView({ changed: [TOUCHED], deleted: [GONE], rows });

describe("rank_chunks working-tree substitution", () => {
  it("ranks the tree's rows of a touched file in place of its base rows, and drops a deleted file's", async () => {
    const results = await rank(treeView());

    expect(results.map((r) => r.id)).toEqual(["t-big", "u"]);
  });

  it("claims the chunks floor and stamps no treeState", async () => {
    const view = treeView();
    const results = await rank(view);

    expect(view.marker.floors).toEqual(["chunks"]);
    expect(results.every((r) => r.treeState === undefined)).toBe(true);
  });

  it("holds the tree's rows to the request filter and the exact pathPattern", async () => {
    const python = codeRow("t-py", { relativePath: TOUCHED, language: "python", methodLines: 99 });
    const filtered = await rank(treeView([python]), {
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });
    const patterned = await rank(treeView(), { pathPattern: "src/untouched.ts" });

    expect(filtered.map((r) => r.id)).not.toContain("t-py");
    expect(patterned.map((r) => r.id)).not.toContain("t-big");
  });

  it("answers from the tree's rows even when the scroll returned nothing", async () => {
    const qdrant = {
      scrollOrdered: vi.fn().mockResolvedValue([]),
      ensurePayloadIndex: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantManager;
    const results = await new ScrollRankStrategy(qdrant, reranker, [METHOD_LINES], []).execute({
      collectionName: "c",
      limit: 10,
      weights: { chunkSize: 1 },
      workingTreeView: treeView(),
    });

    expect(results.map((r) => r.id)).toEqual(["t-big"]);
  });
});
