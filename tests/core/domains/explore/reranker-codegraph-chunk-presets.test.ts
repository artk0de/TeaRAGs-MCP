import { describe, expect, it } from "vitest";

import { Reranker } from "../../../../src/core/domains/explore/reranker.js";
import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";
import { CODEGRAPH_SYMBOLS_DERIVED_SIGNALS } from "../../../../src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/index.js";
import { CODEGRAPH_SYMBOLS_PRESETS } from "../../../../src/core/domains/trajectory/codegraph/symbols/rerank/presets/index.js";
import { staticDerivedSignals } from "../../../../src/core/domains/trajectory/static/rerank/derived-signals/index.js";

/**
 * Method-centrality presets end-to-end through the Reranker. Two properties are
 * pinned here: the chunk-level codegraph weights actually move the ranking, and
 * a chunk from a language codegraph never walked (markdown, sql — enrichment
 * skips files without a walker, so the payload carries no `codegraph` block at
 * all) degrades to its similarity term instead of picking up fabricated zeros
 * in the overlay.
 */
const reranker = new Reranker(
  [...staticDerivedSignals, ...CODEGRAPH_SYMBOLS_DERIVED_SIGNALS],
  [...CODEGRAPH_SYMBOLS_PRESETS],
  [...CODEGRAPH_SYMBOLS_FILE_SIGNALS, ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS],
);

/** A method chunk carrying real codegraph centrality numbers. */
const method = (name: string, pageRank: number, fanIn = 3, fanOut = 4) => ({
  score: 0.7,
  payload: {
    relativePath: `src/${name}.ts`,
    language: "typescript",
    symbolId: name,
    codegraph: { symbols: { chunk: { pageRank, fanIn, fanOut } } },
  },
});

/** A chunk from a file codegraph never walked — no `codegraph` key whatsoever. */
const unwalkedChunk = {
  score: 0.7,
  payload: {
    relativePath: "docs/setup.md",
    language: "markdown",
    symbolId: "setup",
  },
};

describe("criticalMethod through the Reranker", () => {
  it("ranks methods by pageRank when similarity is equal", async () => {
    const ranked = await reranker.rerank(
      [method("low", 0.001), method("high", 0.009), method("mid", 0.005)],
      "criticalMethod",
      "semantic_search",
    );
    expect(ranked.map((r) => r.payload.symbolId)).toEqual(["high", "mid", "low"]);
  });

  it("attributes the ranking to the preset that produced it", async () => {
    const [top] = await reranker.rerank([method("high", 0.009)], "criticalMethod", "semantic_search");
    expect(top.rankingOverlay?.preset).toBe("criticalMethod");
  });
});

describe("a chunk from a language codegraph does not walk", () => {
  it("gets no codegraph keys in its overlay — absent payload, not zeros", async () => {
    const [only] = await reranker.rerank([unwalkedChunk], "criticalMethod", "semantic_search");
    // `extractRawSource` returns early when the payload path resolves to
    // undefined (reranker.ts:776), so an absent block yields no entry at all —
    // no zero-valued pageRank, and no label attached to a zero.
    expect(only.rankingOverlay?.chunk).toBeUndefined();
    expect(only.rankingOverlay?.file).toBeUndefined();
    expect(Object.keys(only.rankingOverlay ?? {})).toEqual(["preset"]);
  });

  it("degrades to the similarity term and ranks below any walked method", async () => {
    const ranked = await reranker.rerank([unwalkedChunk, method("walked", 0.009)], "criticalMethod", "semantic_search");
    expect(ranked.map((r) => r.payload.symbolId)).toEqual(["walked", "setup"]);
    // Equal raw scores → similarity normalizes to 1.0 for both. pageRank
    // extracts 0 for the unwalked chunk (`codegraphChunkNum`'s `?? 0`), so only
    // the 0.3 similarity term survives; the walked method keeps both terms.
    expect(ranked[1].score).toBeCloseTo(0.3, 10);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});
