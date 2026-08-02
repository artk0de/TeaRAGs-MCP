/**
 * Overlay labels for DOTLESS payload keys — bd tea-rags-mcp-u64tm.
 *
 * `buildSignalKeyMap` walked suffixes from `segments.length - 1` down to 1, so
 * a key carrying no dots (`moduleLines`, `fileMethodCount`, `memberCount`,
 * `methodLines`, `methodDensity`) produced no entry at all and
 * `applyLabelResolution` skipped it at `if (!fullKey) continue`. Those signals
 * reached the overlay as bare numbers while their dotted neighbours in the same
 * block carried `{ value, label }`.
 */

import { describe, expect, it } from "vitest";

import type { CollectionSignalStats, PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import type { RerankableResult } from "../../../../src/core/contracts/types/reranker.js";
import { Reranker } from "../../../../src/core/domains/explore/reranker.js";
import { resolvePresets } from "../../../../src/core/domains/explore/rerank/presets/index.js";
import { staticDerivedSignals } from "../../../../src/core/domains/trajectory/static/rerank/derived-signals/index.js";
import { STATIC_PRESETS } from "../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

const presets = resolvePresets([...STATIC_PRESETS], []);

/** The three symbol-mass signals, all dotless, all label-bearing. */
const payloadSignals: PayloadSignalDescriptor[] = [
  {
    key: "moduleLines",
    type: "number",
    description: "Physical line count of the file",
    stats: { labels: { p50: "small", p75: "large", p95: "god-module" }, dedupeByFile: true },
  },
  {
    key: "fileMethodCount",
    type: "number",
    description: "Distinct callables declared in this file",
    stats: { labels: { p50: "typical", p75: "busy", p95: "god-module" }, dedupeByFile: true },
  },
  {
    key: "memberCount",
    type: "number",
    description: "Distinct direct members declared by this class",
    stats: { labels: { p50: "typical", p75: "large", p95: "god-module" } },
  },
];

function statsFor(entries: [string, Record<number, number>][]): CollectionSignalStats {
  const perLanguage = new Map([
    [
      "typescript",
      new Map(entries.map(([key, percentiles]) => [key, { source: { count: 100, min: 1, max: 2000, percentiles } }])),
    ],
  ]);
  return {
    perSignal: new Map(entries.map(([key, percentiles]) => [key, { count: 100, min: 1, max: 2000, percentiles }])),
    perLanguage,
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
  } as CollectionSignalStats;
}

function resultWith(payload: Record<string, unknown>): RerankableResult {
  return {
    score: 0.8,
    payload: {
      relativePath: "src/core/adapters/duckdb/client.ts",
      startLine: 216,
      endLine: 229,
      language: "typescript",
      chunkType: "block",
      ...payload,
    },
  } as RerankableResult;
}

describe("Reranker — overlay labels for dotless payload keys", () => {
  it("labels a file-scoped dotless signal instead of emitting a bare number", async () => {
    const reranker = new Reranker(staticDerivedSignals, presets, payloadSignals);
    reranker.setCollectionStats(statsFor([["moduleLines", { 50: 86, 75: 300, 95: 608 }]]));

    const ranked = await reranker.rerank([resultWith({ moduleLines: 1589 })], "godModule", "rank_chunks");

    // 1589 clears every threshold, so the top label applies.
    expect(ranked[0].rankingOverlay?.file?.moduleLines).toEqual({ value: 1589, label: "god-module" });
  });

  it("labels every dotless signal in the same overlay, not just the first", async () => {
    const reranker = new Reranker(staticDerivedSignals, presets, payloadSignals);
    reranker.setCollectionStats(
      statsFor([
        ["moduleLines", { 50: 86, 75: 300, 95: 608 }],
        ["fileMethodCount", { 50: 3, 75: 15, 95: 30 }],
      ]),
    );

    const ranked = await reranker.rerank(
      [resultWith({ moduleLines: 120, fileMethodCount: 69 })],
      "godModule",
      "rank_chunks",
    );

    const file = ranked[0].rankingOverlay?.file;
    expect(file?.moduleLines).toEqual({ value: 120, label: "small" });
    expect(file?.fileMethodCount).toEqual({ value: 69, label: "god-module" });
  });

  it("resolves the label against the threshold walk, not by saturating at the top", async () => {
    const reranker = new Reranker(staticDerivedSignals, presets, payloadSignals);
    reranker.setCollectionStats(statsFor([["fileMethodCount", { 50: 3, 75: 15, 95: 30 }]]));

    const ranked = await reranker.rerank([resultWith({ fileMethodCount: 20 })], "godModule", "rank_chunks");

    // 20 >= p75 (15) but < p95 (30) — "busy", the middle tier.
    expect(ranked[0].rankingOverlay?.file?.fileMethodCount).toEqual({ value: 20, label: "busy" });
  });

  it("still leaves a dotless signal bare when the collection carries no stats for it", async () => {
    const reranker = new Reranker(staticDerivedSignals, presets, payloadSignals);
    reranker.setCollectionStats(statsFor([["moduleLines", { 50: 86, 75: 300, 95: 608 }]]));

    const ranked = await reranker.rerank(
      [resultWith({ moduleLines: 1589, fileMethodCount: 69 })],
      "godModule",
      "rank_chunks",
    );

    // moduleLines has stats and gets a label; fileMethodCount has none and must
    // stay a plain number rather than inventing a tier.
    expect(ranked[0].rankingOverlay?.file?.moduleLines).toEqual({ value: 1589, label: "god-module" });
    expect(ranked[0].rankingOverlay?.file?.fileMethodCount).toBe(69);
  });

  it("keeps dotted keys resolving exactly as before", async () => {
    const withDotted: PayloadSignalDescriptor[] = [
      ...payloadSignals,
      {
        key: "git.file.commitCount",
        type: "number",
        description: "Total commits",
        stats: { labels: { p50: "typical", p95: "extreme" } },
      },
    ];
    const reranker = new Reranker(staticDerivedSignals, presets, withDotted);
    reranker.setCollectionStats(
      statsFor([
        ["moduleLines", { 50: 86, 75: 300, 95: 608 }],
        ["git.file.commitCount", { 50: 5, 95: 40 }],
      ]),
    );

    const ranked = await reranker.rerank(
      [resultWith({ moduleLines: 1589, git: { file: { commitCount: 50 } } })],
      "godModule",
      "rank_chunks",
    );

    expect(ranked[0].rankingOverlay?.file?.moduleLines).toEqual({ value: 1589, label: "god-module" });
  });
});
