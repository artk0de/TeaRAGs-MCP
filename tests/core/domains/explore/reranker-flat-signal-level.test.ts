/**
 * Overlay bucket for FLAT (dotless) payload signals — bd tea-rags-mcp-llmc0.
 *
 * `Reranker#extractRawSource` used to pick the bucket by whether the resolved
 * path contains `.chunk.`. A flat key never does, so every flat structural
 * signal landed under `rankingOverlay.file` — `methodLines`, which measures the
 * METHOD, was reported as a file fact. A flat signal's level is the one its
 * `PayloadSignalDescriptor` declares: `level: "file"` → file, anything else →
 * chunk. Nested keys keep the `.file.` / `.chunk.` path rule.
 */

import { describe, expect, it } from "vitest";

import type { RerankableResult, RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import type { CollectionSignalStats } from "../../../../src/core/contracts/types/trajectory.js";
import { resolvePresets } from "../../../../src/core/domains/explore/rerank/presets/index.js";
import { Reranker } from "../../../../src/core/domains/explore/reranker.js";
import { gitPayloadSignalDescriptors } from "../../../../src/core/domains/trajectory/git/payload-signals.js";
import { BASE_PAYLOAD_SIGNALS } from "../../../../src/core/domains/trajectory/static/payload-signals.js";
import { staticDerivedSignals } from "../../../../src/core/domains/trajectory/static/rerank/derived-signals/index.js";
import { STATIC_PRESETS } from "../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

/** A mask that lists both flat kinds in the WRONG bucket, to prove the descriptor decides. */
class MisplacedMaskPreset implements RerankPreset {
  readonly name = "misplacedMask";
  readonly description = "test preset";
  readonly tools = ["rank_chunks"];
  readonly weights = { similarity: 0.5, chunkSize: 0.5 };
  readonly overlayMask = { file: ["methodLines", "git.file.commitCount"], chunk: ["moduleLines"] };
}

/** A file-level preset whose mask names a chunk-scoped flat signal. */
class FileLevelPreset implements RerankPreset {
  readonly name = "fileLevelMask";
  readonly description = "test preset";
  readonly tools = ["rank_chunks"];
  readonly signalLevel = "file" as const;
  readonly weights = { similarity: 0.5, chunkSize: 0.5 };
  readonly overlayMask = { file: ["moduleLines", "methodLines"], chunk: ["methodDensity"] };
}

const presets = resolvePresets([...STATIC_PRESETS, new MisplacedMaskPreset(), new FileLevelPreset()], []);
const payloadSignals = [...BASE_PAYLOAD_SIGNALS, ...gitPayloadSignalDescriptors];

function resultWith(payload: Record<string, unknown>): RerankableResult {
  return {
    score: 0.8,
    payload: {
      relativePath: "src/core/domains/explore/reranker.ts",
      startLine: 10,
      endLine: 253,
      language: "typescript",
      chunkType: "function",
      contentSize: 9000,
      methodLines: 244,
      methodDensity: 37,
      moduleLines: 1200,
      git: { file: { commitCount: 12 } },
      ...payload,
    },
  };
}

function statsFor(entries: [string, Record<number, number>][]): CollectionSignalStats {
  return {
    perSignal: new Map(entries.map(([key, percentiles]) => [key, { count: 100, min: 1, max: 2000, percentiles }])),
    perLanguage: new Map([
      [
        "typescript",
        new Map(entries.map(([key, percentiles]) => [key, { source: { count: 100, min: 1, max: 2000, percentiles } }])),
      ],
    ]),
    distributions: {
      totalFiles: 100,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 100 },
      topAuthors: [],
      topBlameAuthors: [],
      othersCount: 0,
    },
    computedAt: 1,
  };
}

describe("Reranker — overlay bucket of flat payload signals (llmc0)", () => {
  it("puts the decomposition preset's methodLines under chunk, not file", async () => {
    const reranker = new Reranker(staticDerivedSignals, presets, payloadSignals);
    const ranked = await reranker.rerank([resultWith({})], "decomposition", "rank_chunks");

    const overlay = ranked[0].rankingOverlay!;
    expect(overlay.chunk?.methodLines).toBe(244);
    expect(overlay.file?.methodLines).toBeUndefined();
  });

  it("buckets a flat signal by its descriptor level whichever mask bucket names it", async () => {
    const reranker = new Reranker(staticDerivedSignals, presets, payloadSignals);
    const ranked = await reranker.rerank([resultWith({})], "misplacedMask", "rank_chunks");

    const overlay = ranked[0].rankingOverlay!;
    // chunk-scoped flat key (no `level: "file"`) → chunk
    expect(overlay.chunk?.methodLines).toBe(244);
    // file-scoped flat key (`level: "file"`) → file
    expect(overlay.file?.moduleLines).toBe(1200);
    expect(overlay.chunk?.moduleLines).toBeUndefined();
    expect(overlay.file?.methodLines).toBeUndefined();
    // nested keys keep the path rule
    expect(overlay.file?.commitCount).toBe(12);
  });

  it("keeps methodLines' label under chunk, resolved from the same stats key", async () => {
    const reranker = new Reranker(staticDerivedSignals, presets, payloadSignals);
    reranker.setCollectionStats(statsFor([["methodLines", { 50: 20, 75: 60, 95: 150 }]]));

    const ranked = await reranker.rerank([resultWith({})], "decomposition", "rank_chunks");

    expect(ranked[0].rankingOverlay?.chunk?.methodLines).toEqual({ value: 244, label: "decomposition_candidate" });
  });

  it("drops chunk-scoped flat signals from a file-level result's overlay", async () => {
    const reranker = new Reranker(staticDerivedSignals, presets, payloadSignals);
    const ranked = await reranker.rerank([resultWith({})], "fileLevelMask", "rank_chunks");

    const overlay = ranked[0].rankingOverlay!;
    // The file hit is reduced to file scope, so a value measured on the
    // representative chunk must not surface anywhere in its overlay.
    expect(overlay.file?.moduleLines).toBe(1200);
    expect(overlay.file?.methodLines).toBeUndefined();
    expect(overlay.chunk).toBeUndefined();
  });
});
