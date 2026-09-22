/**
 * The stats-cache axis. Before it existed the cache carried no stamp at all, so
 * a change to WHAT a signal samples was invisible to every monitor — and the
 * numbers it moved are read by filter presets and adaptive bounds, not only by
 * labels.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeStatsSamplingContract } from "../../../../../src/core/contracts/signal-utils.js";
import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import { formatIndexDriftReport, IndexDriftReporter } from "../../../../../src/core/domains/maintenance/drift/index.js";
import { StatsContractDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/stats-contract-drift-monitor.js";
import { StatsCache } from "../../../../../src/core/infra/stats-cache.js";

const COLLECTION = "code_test";

function signal(stats: PayloadSignalDescriptor["stats"]): PayloadSignalDescriptor {
  return { key: "git.file.bugFixRate", type: "number", description: "bug-fix share", stats };
}

const PER_FILE = signal({ labels: { p50: "concerning" }, dedupeByFile: true });
const PER_CHUNK = signal({ labels: { p50: "concerning" } });

describe("StatsContractDriftMonitor", () => {
  let dir: string;
  let cache: StatsCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stats-contract-drift-"));
    cache = new StatsCache(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeStats(opts: { count: number; totalFiles: number; samplingContract?: Record<string, string> }): void {
    writeFileSync(
      join(dir, `${COLLECTION}.stats.json`),
      JSON.stringify({
        version: 7,
        collectionName: COLLECTION,
        computedAt: 1,
        perSignal: { "git.file.bugFixRate": { count: opts.count, min: 0, max: 100, percentiles: { 50: 25 } } },
        perLanguage: {},
        distributions: { totalFiles: opts.totalFiles },
        payloadFieldKeys: ["git.file.bugFixRate"],
        ...(opts.samplingContract ? { samplingContract: opts.samplingContract } : {}),
      }),
      "utf-8",
    );
  }

  it("stays silent when there is no stats file to judge", () => {
    expect(new StatsContractDriftMonitor(cache, [PER_FILE]).check(COLLECTION)).toEqual([]);
  });

  describe("against a stamped file", () => {
    it("stays silent while the stamp matches what the build declares", () => {
      writeStats({ count: 9, totalFiles: 10, samplingContract: describeStatsSamplingContract([PER_FILE]) });

      expect(new StatsContractDriftMonitor(cache, [PER_FILE]).check(COLLECTION)).toEqual([]);
    });

    it("reports the signal whose sampling declaration moved", () => {
      writeStats({ count: 9, totalFiles: 10, samplingContract: describeStatsSamplingContract([PER_CHUNK]) });

      const [finding, ...rest] = new StatsContractDriftMonitor(cache, [PER_FILE]).check(COLLECTION);

      expect(rest).toEqual([]);
      expect(finding.subject).toBe("git.file.bugFixRate");
      expect(finding.current).toContain("perFile=true");
      expect(finding.indexed).toContain("perFile=false");
    });

    // A sample is what it is regardless of how a stored percentile is later
    // read, so demanding a recompute here would cost a rescroll to reproduce
    // byte-identical numbers.
    it("ignores a change that cannot move a single stored number", () => {
      const before = signal({ labels: { p50: "concerning" }, dedupeByFile: true, bandTieBreak: "upper" });
      const after = signal({ labels: { p50: "concerning" }, dedupeByFile: true, bandTieBreak: "lower" });
      writeStats({ count: 9, totalFiles: 10, samplingContract: describeStatsSamplingContract([before]) });

      expect(new StatsContractDriftMonitor(cache, [after]).check(COLLECTION)).toEqual([]);
    });

    it("reports a signal the stamped run never sampled at all", () => {
      writeStats({ count: 9, totalFiles: 10, samplingContract: {} });

      const [finding] = new StatsContractDriftMonitor(cache, [PER_FILE]).check(COLLECTION);

      expect(finding.indexed).toBe("not sampled");
    });
  });

  describe("against a file written before the stamp existed", () => {
    it("infers the chunk-weighted sample from more observations than files", () => {
      writeStats({ count: 26552, totalFiles: 2453 });

      const [finding, ...rest] = new StatsContractDriftMonitor(cache, [PER_FILE]).check(COLLECTION);

      expect(rest).toEqual([]);
      expect(finding.indexed).toBe("26552 observations over 2453 files");
      expect(finding.note).toContain("predates the sampling stamp");
    });

    it("stays silent when the sample already holds at most one value per file", () => {
      writeStats({ count: 2453, totalFiles: 2453 });

      expect(new StatsContractDriftMonitor(cache, [PER_FILE]).check(COLLECTION)).toEqual([]);
    });

    // The inference is one-way on purpose: without a file total there is no
    // denominator, and guessing "stale" would re-run the migration forever.
    it("declines to judge a file carrying no file total", () => {
      writeStats({ count: 26552, totalFiles: 0 });

      expect(new StatsContractDriftMonitor(cache, [PER_FILE]).check(COLLECTION)).toEqual([]);
    });

    it("says nothing about a signal that never claimed one value per file", () => {
      writeStats({ count: 26552, totalFiles: 2453 });

      expect(new StatsContractDriftMonitor(cache, [PER_CHUNK]).check(COLLECTION)).toEqual([]);
    });
  });

  // The whole point of the remedy lattice: this axis is repaired by a migration
  // over payload already on disk, so it must not escalate anyone to `--force`.
  it("asks for a plain incremental, never a rebuild", () => {
    writeStats({ count: 26552, totalFiles: 2453 });
    const reporter = new IndexDriftReporter([new StatsContractDriftMonitor(cache, [PER_FILE])], () => "tea-rags");

    const report = reporter.checkByCollectionName(COLLECTION);

    expect(report?.remedy).toEqual({ kind: "incremental" });
    expect(formatIndexDriftReport(report!)).toContain("Run: tea-rags index-codebase --project tea-rags");
    expect(formatIndexDriftReport(report!)).not.toContain("--force");
  });
});
