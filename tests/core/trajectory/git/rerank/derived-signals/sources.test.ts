/**
 * Programmatic verification that derived signal sources declarations
 * match their actual payload access patterns.
 *
 * Rules:
 * - Blended signals (using blendSignal/blendNormalized) must declare both file+chunk sources
 * - Chunk-primary signals (using payloadAlpha) must include file.commitCount in sources
 * - All sources must resolve to valid payload paths via buildSignalKeyMap
 */

import { describe, expect, it } from "vitest";

import { gitPayloadSignalDescriptors } from "../../../../../../src/core/trajectory/git/payload-signals.js";
import { gitDerivedSignals } from "../../../../../../src/core/trajectory/git/rerank/derived-signals/index.js";

/** Build source → full-path map (same logic as reranker's buildSignalKeyMap) */
function buildKeyMap(signals: typeof gitPayloadSignalDescriptors): Map<string, string> {
  const map = new Map<string, string>();
  for (const ps of signals) {
    const segments = ps.key.split(".");
    for (let len = segments.length - 1; len >= 1; len--) {
      const suffix = segments.slice(segments.length - len).join(".");
      if (len === 1) {
        if (!map.has(suffix)) map.set(suffix, ps.key);
      } else {
        map.set(suffix, ps.key);
      }
    }
  }
  return map;
}

describe("derived signal sources declarations", () => {
  const keyMap = buildKeyMap(gitPayloadSignalDescriptors);

  it("all sources resolve to valid payload paths", () => {
    for (const d of gitDerivedSignals) {
      for (const source of d.sources) {
        const resolved = keyMap.get(source);
        expect(resolved, `Signal '${d.name}' source '${source}' does not resolve`).toBeDefined();
      }
    }
  });

  /** Signals known to use blendSignal/blendNormalized — must have both file+chunk sources */
  const BLENDED_SIGNALS = [
    "recency",
    "stability",
    "churn",
    "age",
    "bugFix",
    "volatility",
    "density",
    "relativeChurnNorm",
    "burstActivity",
    "knowledgeSilo",
  ];

  it("blended signals declare both file and chunk sources", () => {
    for (const name of BLENDED_SIGNALS) {
      const d = gitDerivedSignals.find((s) => s.name === name);
      expect(d, `Signal '${name}' not found`).toBeDefined();
      if (!d) continue;

      const fileSources = d.sources.filter((s) => s.startsWith("file."));
      const chunkSources = d.sources.filter((s) => s.startsWith("chunk."));
      expect(fileSources.length, `Signal '${name}' missing file-level sources`).toBeGreaterThan(0);
      expect(chunkSources.length, `Signal '${name}' missing chunk-level sources`).toBeGreaterThan(0);
    }
  });

  /** Chunk-primary signals using payloadAlpha — must include file.commitCount */
  const CHUNK_PRIMARY_SIGNALS = ["chunkChurn", "chunkRelativeChurn"];

  it("chunk-primary signals include file.commitCount for payloadAlpha", () => {
    for (const name of CHUNK_PRIMARY_SIGNALS) {
      const d = gitDerivedSignals.find((s) => s.name === name);
      expect(d, `Signal '${name}' not found`).toBeDefined();
      if (!d) continue;

      expect(
        d.sources.includes("file.commitCount"),
        `Signal '${name}' missing 'file.commitCount' source for payloadAlpha`,
      ).toBe(true);
    }
  });
});
