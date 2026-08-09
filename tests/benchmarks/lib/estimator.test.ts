/**
 * The tune benchmark's payoff: measured embedding/storage throughput projected
 * onto reference project sizes, so an operator can answer "what will indexing
 * my 3.5M-LoC monorepo cost?" without running it. Two consumers share the
 * arithmetic — the printed table and `getTimeEstimatesData`, which the tuned
 * env file embeds as comments — so the projection, the divide-by-zero guard
 * for an un-measured rate, and the duration/number formatting are pinned here.
 */

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error - benchmarks/ is plain JS outside the TS program, so it ships no declarations
import { c } from "../../../benchmarks/lib/colors.mjs";
// @ts-expect-error - benchmarks/ is plain JS outside the TS program, so it ships no declarations
import { AVG_LOC_PER_CHUNK, PROJECT_SIZES } from "../../../benchmarks/lib/config.mjs";
// @ts-expect-error - benchmarks/ is plain JS outside the TS program, so it ships no declarations
import { getTimeEstimatesData, printTimeEstimates } from "../../../benchmarks/lib/estimator.mjs";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

interface TimeEstimate {
  name: string;
  loc: number;
  chunks: number;
  embeddingTime: number;
  storageTime: number;
  totalTime: number;
  formattedTotal: string;
}

function captureLog(run: () => void): string[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    run();
    return spy.mock.calls.map((args) => args.map(String).join(" "));
  } finally {
    spy.mockRestore();
  }
}

/**
 * 50 chunks/s embedding + 1000 chunks/s storage spans every duration unit and
 * every severity tier across the reference sizes — seconds for the CLI tool,
 * minutes mid-table, over an hour for the kernel.
 */
const SLOW_EMBEDDING_RATE = 50;
const FAST_STORAGE_RATE = 1000;

describe("getTimeEstimatesData", () => {
  it("projects one estimate per reference size from the measured rates", () => {
    const rows = getTimeEstimatesData(100, 500) as TimeEstimate[];

    expect(rows).toHaveLength(PROJECT_SIZES.length);
    for (const [index, row] of rows.entries()) {
      const project = PROJECT_SIZES[index];
      expect(row.name).toBe(project.name);
      expect(row.loc).toBe(project.loc);
      expect(row.chunks).toBe(Math.ceil(project.loc / AVG_LOC_PER_CHUNK));
      expect(row.embeddingTime).toBeCloseTo(row.chunks / 100);
      expect(row.storageTime).toBeCloseTo(row.chunks / 500);
      expect(row.totalTime).toBeCloseTo(row.embeddingTime + row.storageTime);
    }
  });

  it("reports zero rather than Infinity when a rate was never measured", () => {
    const rows = getTimeEstimatesData(0, 0) as TimeEstimate[];

    expect(rows.every((row) => Number.isFinite(row.totalTime))).toBe(true);
    expect(rows.every((row) => row.totalTime === 0)).toBe(true);
    expect(rows[0].formattedTotal).toBe("0s");
  });

  it("scales the duration unit with the estimate: seconds, minutes, then hours", () => {
    const formatted = (getTimeEstimatesData(SLOW_EMBEDDING_RATE, FAST_STORAGE_RATE) as TimeEstimate[]).map(
      (row) => row.formattedTotal,
    );

    // Sub-minute stays in seconds; whole minutes drop the seconds part; and the
    // largest reference size crosses into hours.
    expect(formatted.some((value) => /^\d+s$/.test(value))).toBe(true);
    expect(formatted.some((value) => /^\d+m \d+s$/.test(value))).toBe(true);
    expect(formatted.some((value) => /^\d+m$/.test(value))).toBe(true);
    expect(formatted.some((value) => /^\d+h \d+m$/.test(value))).toBe(true);
  });

  it("keeps the printed table and the env-file comments on the same arithmetic", () => {
    const rows = getTimeEstimatesData(SLOW_EMBEDDING_RATE, FAST_STORAGE_RATE) as TimeEstimate[];
    const printed = captureLog(() => {
      printTimeEstimates(SLOW_EMBEDDING_RATE, FAST_STORAGE_RATE);
    })
      .join("\n")
      .replace(ANSI, "");

    for (const row of rows) {
      expect(printed).toContain(row.formattedTotal);
    }
  });
});

describe("printTimeEstimates", () => {
  it("renders a labelled row per reference size with K/M-abbreviated magnitudes", () => {
    const printed = captureLog(() => {
      printTimeEstimates(SLOW_EMBEDDING_RATE, FAST_STORAGE_RATE);
    })
      .join("\n")
      .replace(ANSI, "");

    expect(printed).toContain("Project Type");
    expect(printed).toContain("Chunks");
    expect(printed).toContain("Embedding");
    expect(printed).toContain("Storage");
    for (const project of PROJECT_SIZES) {
      expect(printed).toContain(project.name);
    }
    // Thousands collapse to K, millions to one decimal M, and a bare count
    // under 1000 (the smallest project's chunk count) stays as-is.
    expect(printed).toMatch(/\b10K\b/);
    expect(printed).toMatch(/\b3\.5M\b/);
    expect(printed).toMatch(/\b200\b/);
  });

  it("states the rates the projection was derived from", () => {
    const printed = captureLog(() => {
      printTimeEstimates(SLOW_EMBEDDING_RATE, FAST_STORAGE_RATE);
    })
      .join("\n")
      .replace(ANSI, "");

    expect(printed).toContain(`${SLOW_EMBEDDING_RATE} chunks/s (embedding)`);
    expect(printed).toContain(`${FAST_STORAGE_RATE} chunks/s (storage)`);
  });

  it("colours each row by how painful that project's total is", () => {
    const printed = captureLog(() => {
      printTimeEstimates(SLOW_EMBEDDING_RATE, FAST_STORAGE_RATE);
    }).join("\n");

    // Under a minute is green, under ten minutes yellow, and an hour-plus red.
    expect(printed).toContain(c.green);
    expect(printed).toContain(c.yellow);
    expect(printed).toContain(c.red);
  });
});
