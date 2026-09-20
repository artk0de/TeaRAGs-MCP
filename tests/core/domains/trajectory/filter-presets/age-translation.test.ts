import { describe, expect, it } from "vitest";

import type {
  AdaptiveFilterCondition,
  FilterPresetDef,
} from "../../../../../src/core/contracts/types/filter-preset.js";
import type { CollectionSignalStats } from "../../../../../src/core/contracts/types/trajectory.js";
import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";

const NOW = 1_800_000_000;
const DAY = 86_400;

const def = (conditions: AdaptiveFilterCondition[]): FilterPresetDef => ({
  name: "ageTranslationFixture",
  description: "fixture",
  requires: ["git"],
  conditions,
});

const statsWith = (key: string, percentiles: Record<number, number>): CollectionSignalStats => ({
  perSignal: new Map([[key, { count: 10, min: 0, max: 1, percentiles }]]),
  perLanguage: new Map(),
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

describe("filter-preset compiler — ageDays → now-relative lastModifiedAt translation", () => {
  it("fixed days flip the op and become a now-relative timestamp", () => {
    // age ≤ 7 ⟺ lastModifiedAt ≥ now − 7·day
    const f = compileFilterPreset(def([{ signal: "git.chunk.ageDays", op: "lte", value: 7 }]), undefined, "chunk", NOW);
    expect(f.must).toContainEqual({ key: "git.chunk.lastModifiedAt", range: { gte: NOW - 7 * DAY } });
  });

  it("percentile inverts (age p75 ⇔ stamp p25); fallback days become a now-relative stamp", () => {
    // no stats → cold-start fallback = now − 60 days
    const f = compileFilterPreset(
      def([{ signal: "git.file.ageDays", op: "gte", value: { percentile: "p75", fallback: 60 } }]),
      undefined,
      "file",
      NOW,
    );
    expect(f.must).toContainEqual({ key: "git.file.lastModifiedAt", range: { gt: 0, lte: NOW - 60 * DAY } });
  });

  it("resolves the INVERTED percentile from the lastModifiedAt stats", () => {
    const stats = statsWith("git.file.lastModifiedAt", { 5: NOW - 200 * DAY, 25: NOW - 90 * DAY, 50: NOW - 30 * DAY });
    const f = compileFilterPreset(
      def([{ signal: "git.file.ageDays", op: "gte", value: { percentile: "p75", fallback: 60 } }]),
      stats,
      "file",
      NOW,
    );
    // age ≥ p75(age) ⟺ lastModifiedAt ≤ p25(stamp) = now − 90 days
    expect(f.must).toContainEqual({ key: "git.file.lastModifiedAt", range: { gt: 0, lte: NOW - 90 * DAY } });
  });

  it("median is symmetric: age p50 translates to stamp p50", () => {
    const stats = statsWith("git.file.lastModifiedAt", { 50: NOW - 14 * DAY });
    const f = compileFilterPreset(
      def([{ signal: "git.file.ageDays", op: "gte", value: { percentile: "p50", fallback: 30 } }]),
      stats,
      "file",
      NOW,
    );
    expect(f.must).toContainEqual({ key: "git.file.lastModifiedAt", range: { gt: 0, lte: NOW - 14 * DAY } });
  });

  it("missing-stats fallback uses the now-relative timestamp even when a percentile is requested", () => {
    const stats = statsWith("git.file.commitCount", { 25: 5 }); // no lastModifiedAt stats at all
    const f = compileFilterPreset(
      def([{ signal: "git.file.ageDays", op: "gte", value: { percentile: "p75", fallback: 42 } }]),
      stats,
      "file",
      NOW,
    );
    expect(f.must).toContainEqual({ key: "git.file.lastModifiedAt", range: { gt: 0, lte: NOW - 42 * DAY } });
  });

  it("non-age conditions compile unchanged", () => {
    const f = compileFilterPreset(
      def([{ signal: "git.chunk.commitCount", op: "gte", value: { percentile: "p75", fallback: 5 } }]),
      undefined,
      "chunk",
      NOW,
    );
    expect(f.must).toContainEqual({ key: "git.chunk.commitCount", range: { gte: 5 } });
  });

  it("defaults the clock to now when the nowSec argument is omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const f = compileFilterPreset(def([{ signal: "git.chunk.ageDays", op: "lte", value: 7 }]), undefined, "chunk");
    const after = Math.floor(Date.now() / 1000);
    const cond = f.must?.find((c) => "key" in c && c.key === "git.chunk.lastModifiedAt") as
      | { range?: { gte?: number } }
      | undefined;
    expect(cond?.range?.gte).toBeGreaterThanOrEqual(before - 7 * DAY);
    expect(cond?.range?.gte).toBeLessThanOrEqual(after - 7 * DAY);
  });
});
