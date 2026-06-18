import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import { Reranker } from "../../../../src/core/domains/explore/reranker.js";
import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";
import { CODEGRAPH_SYMBOLS_DERIVED_SIGNALS } from "../../../../src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/index.js";

// Reranker raw-value + overlay paths must address codegraph payloads through the
// real nested shape `payload.codegraph.symbols.file.fanIn`. With the descriptor
// `sources` in suffix convention ("file.fanIn"), signalKeyMap resolves to the
// full key, computeAdaptiveBounds collects the batch, and the bound lands under
// the key the extract reads.
const fanInPreset: RerankPreset = {
  name: "cgFanIn",
  description: "fanIn-only preset for adaptive-bound + overlay coverage",
  tools: ["semantic_search"],
  weights: { fanIn: 1.0 },
  overlayMask: { file: ["codegraph.file.fanIn"] },
};

const reranker = new Reranker(
  CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
  [fanInPreset],
  [...CODEGRAPH_SYMBOLS_FILE_SIGNALS, ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS],
);

const nested = (fanIn: number) => ({
  score: 0.5,
  payload: { relativePath: `src/f${fanIn}.ts`, codegraph: { symbols: { file: { fanIn } } } },
});

describe("Reranker codegraph addressing — adaptive bounds + overlay on nested-symbols payload", () => {
  it("normalizes fanIn against the BATCH p95 bound, not the static defaultBound", async () => {
    const ranked = await reranker.rerank([nested(50), nested(5)], "cgFanIn", "semantic_search");
    const low = ranked.find((r) => r.payload?.codegraph?.symbols?.file?.fanIn === 5)!;
    // batch p95([5,50]) = 50 → normalize(5, 50) = 0.1.
    // Broken addressing fell back to defaultBound 20 → normalize(5, 20) = 0.25.
    expect(low.score).toBeCloseTo(0.1, 6);
  });

  it("populates the ranking overlay from the nested codegraph payload", async () => {
    const ranked = await reranker.rerank([nested(50), nested(5)], "cgFanIn", "semantic_search");
    const high = ranked.find((r) => r.payload?.codegraph?.symbols?.file?.fanIn === 50)!;
    expect(high.rankingOverlay?.file?.fanIn).toBe(50);
  });
});
