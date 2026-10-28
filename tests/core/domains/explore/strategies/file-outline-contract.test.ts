/**
 * FileOutlineStrategy — answer contract of find_symbol `relativePath` (bd
 * tea-rags-mcp-hditp): a file of more than one scroll page is outlined whole,
 * `metaOnly` answers the outline (the outline IS the metadata), and a file
 * with no symbol chunk says so instead of answering a bare path line.
 */

import { describe, expect, it } from "vitest";

import { fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import { FileOutlineStrategy } from "../../../../../src/core/domains/explore/strategies/file-outline.js";

interface Row {
  id: string;
  payload: Record<string, unknown>;
}

/** A scroll that returns `rows` up to the requested limit, as Qdrant pages do. */
function cappedQdrant(rows: readonly Row[]) {
  return {
    scrollFiltered: async (_collection: string, _filter: unknown, limit: number) => rows.slice(0, limit),
  } as any;
}

const reranker = {
  rerank: (r: unknown[]) => r,
  hasCollectionStats: false,
  setCollectionStats: () => undefined,
  getDescriptors: () => [],
  getFullPreset: () => undefined,
} as any;

function functionRows(path: string, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    payload: {
      symbolId: `helper_${i}`,
      chunkType: "function",
      relativePath: path,
      startLine: 1 + i * 4,
      endLine: 3 + i * 4,
      language: "ruby",
      content: `def helper_${i}; end`,
    },
  }));
}

/** Top-level DSL/config chunks: no chunk carries a symbolId. */
function anonymousRows(path: string): Row[] {
  return [0, 1, 2].map((i) => ({
    id: `a${i}`,
    payload: {
      chunkType: "block",
      relativePath: path,
      startLine: 1 + i * 80,
      endLine: 80 + i * 80,
      language: "ruby",
      content: `configure_block_${i}`,
    },
  }));
}

function treeView(path: string, lineCount: number) {
  const text = Array.from({ length: lineCount }, (_, i) => `line_${i}`).join("\n");
  return fakeWorkingTreeView({ files: { [path]: text } });
}

describe("FileOutlineStrategy — answer contract (hditp)", () => {
  it("outlines every chunk of a file larger than one 200-chunk page", async () => {
    const path = "lib/big_module.rb";
    const strategy = new FileOutlineStrategy(cappedQdrant(functionRows(path, 260)), reranker, [], [], {
      relativePath: path,
    });

    const results = await strategy.execute({ collectionName: "c", limit: 1 });

    expect(results[0].payload?.chunkCount).toBe(260);
    expect(String(results[0].payload?.content)).toContain("helper_259");
  });

  it("answers metaOnly with the outline, never a bare path stub", async () => {
    const path = "lib/small_module.rb";
    const strategy = new FileOutlineStrategy(cappedQdrant(functionRows(path, 3)), reranker, [], [], {
      relativePath: path,
    });

    const results = await strategy.execute({ collectionName: "c", limit: 1, metaOnly: true });

    const outline = String(results[0].payload?.content);
    expect(outline).toContain("helper_0");
    expect(outline).toContain("helper_2");
    expect(outline).not.toContain("def helper_0");
  });

  it("answers a large file without symbol chunks with the noSymbols empty reason", async () => {
    const path = "config/initializers/metrics.rb";
    const strategy = new FileOutlineStrategy(cappedQdrant(anonymousRows(path)), reranker, [], [], {
      relativePath: path,
    });

    const results = await strategy.execute({ collectionName: "c", limit: 1, workingTreeView: treeView(path, 240) });

    expect(results).toEqual([]);
    expect(strategy.emptyAnswer?.reason).toBe("noSymbols");
    expect(strategy.emptyAnswer?.message).toContain("default code read tool");
  });

  it("still answers a small file without symbol chunks with its full text", async () => {
    const path = "config/initializers/small.rb";
    const strategy = new FileOutlineStrategy(cappedQdrant(anonymousRows(path)), reranker, [], [], {
      relativePath: path,
    });

    const results = await strategy.execute({ collectionName: "c", limit: 1, workingTreeView: treeView(path, 40) });

    expect(results[0].payload?.kind).toBe("file");
    expect(strategy.emptyAnswer).toBeUndefined();
  });
});
