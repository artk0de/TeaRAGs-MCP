/**
 * Overlay ageDays is derived at query time from lastModifiedAt (bd
 * tea-rags-mcp-9ot33). The scenario the change exists for: a point whose
 * STAMPED ageDays is 0 (stale enrichment) but whose real lastModifiedAt is
 * months old must show the honest age and the now-relative label band.
 */

import { describe, expect, it } from "vitest";

import type {
  CollectionSignalStats,
  ScopedSignalStats,
  SignalStats,
} from "../../../../src/core/contracts/types/trajectory.js";
import { resolvePresets } from "../../../../src/core/domains/explore/rerank/presets/index.js";
import { Reranker, type RerankableResult } from "../../../../src/core/domains/explore/reranker.js";
import { gitPayloadSignalDescriptors } from "../../../../src/core/domains/trajectory/git/payload-signals.js";
import { gitDerivedSignals } from "../../../../src/core/domains/trajectory/git/rerank/derived-signals/index.js";
import { GIT_PRESETS } from "../../../../src/core/domains/trajectory/git/rerank/presets/index.js";

const NOW = 1_800_000_000;
const DAY = 86_400;

const stats = (percentiles: Record<number, number>): SignalStats => ({
  count: 100,
  min: 0,
  max: 1,
  percentiles,
});

const scoped = (percentiles: Record<number, number>): ScopedSignalStats => ({ source: stats(percentiles) });

const collectionStats = (): CollectionSignalStats => ({
  perSignal: new Map(),
  perLanguage: new Map([
    [
      "typescript",
      new Map([
        ["git.file.lastModifiedAt", scoped({ 5: NOW - 200 * DAY, 25: NOW - 90 * DAY, 50: NOW - 30 * DAY })],
        ["git.chunk.lastModifiedAt", scoped({ 5: NOW - 200 * DAY, 25: NOW - 90 * DAY, 50: NOW - 30 * DAY })],
      ]),
    ],
  ]),
  distributions: {
    totalFiles: 1,
    language: {},
    chunkType: {},
    documentation: { docs: 0, code: 0 },
    topAuthors: [],
    topBlameAuthors: [],
    othersCount: 0,
  },
  computedAt: NOW,
});

const result = (fileStampDaysAgo: number, chunkStampDaysAgo: number): RerankableResult => ({
  score: 0.9,
  payload: {
    relativePath: "src/legacy.ts",
    language: "typescript",
    git: {
      file: {
        // The stale enrichment stamp claims "fresh" (0) — the read path must
        // ignore it and derive from the timestamp instead (mopt7).
        ageDays: 0,
        lastModifiedAt: NOW - fileStampDaysAgo * DAY,
        commitCount: 10,
      },
      chunk: {
        ageDays: 0,
        lastModifiedAt: NOW - chunkStampDaysAgo * DAY,
        commitCount: 3,
      },
    },
  },
});

describe("Reranker overlay ageDays — query-time derivation", () => {
  const reranker = new Reranker(gitDerivedSignals, resolvePresets([...GIT_PRESETS], []), gitPayloadSignalDescriptors);
  reranker.setCollectionStats(collectionStats(), { collectionName: "test" });

  it("overlay value comes from lastModifiedAt, not the stale stamp", async () => {
    const [r] = await reranker.rerank([result(200, 5)], "techDebt", "semantic_search", { now: NOW });
    expect(r.rankingOverlay?.file?.ageDays).toEqual({ value: 200, label: "legacy" });
    expect(r.rankingOverlay?.chunk?.ageDays).toEqual({ value: 5, label: "recent" });
  });

  it("labels come from now-relative bands (age p75 ⇔ stamp p25)", async () => {
    // 100 days old: above the p25-inverted "old" band (90d), below p50 (30d inverted…)
    // bands: {50: 30, 75: 90, 95: 200} → 100d lands on "old".
    const [r] = await reranker.rerank([result(100, 40)], "techDebt", "semantic_search", { now: NOW });
    expect(r.rankingOverlay?.file?.ageDays).toEqual({ value: 100, label: "old" });
    expect(r.rankingOverlay?.chunk?.ageDays).toEqual({ value: 40, label: "typical" });
  });

  it("points with no stamp drop out of the overlay instead of showing a fake age", async () => {
    const [r] = await reranker.rerank(
      [
        {
          score: 0.9,
          payload: { relativePath: "docs/readme.md", language: "markdown", git: { file: { commitCount: 10 } } },
        },
      ],
      "techDebt",
      "semantic_search",
      { now: NOW },
    );
    expect(r.rankingOverlay?.file?.ageDays).toBeUndefined();
  });

  it("age sources bound against the now-relative floor — old code ranks above fresh on techDebt", async () => {
    // Batch ages p95 = 200; collection floor now − p5(stamp) = 200 → the old
    // point's age normalizes to 1.0. A frozen index-time ageDays p95 (never
    // backfilled on this fixture) could not produce that ordering.
    const reranked = await reranker.rerank([result(1, 1), result(200, 200)], "techDebt", "semantic_search", {
      now: NOW,
    });
    expect(reranked[0].payload?.git).toBeDefined();
    const oldest = (reranked[0].payload?.git as { file?: { lastModifiedAt?: number } }).file?.lastModifiedAt;
    expect(oldest).toBe(NOW - 200 * DAY);
  });
});
