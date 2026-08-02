/**
 * `computeExtractionRepair` — the exactness invariant (bd tea-rags-mcp-6goqa).
 *
 * The repair set is what decides whether a run silently re-extracts. Too wide
 * and every run pays a full re-parse; too narrow and stale rows survive
 * forever, which is the defect this whole change exists to close. So the
 * invariant asserted here is exactness, not "roughly right".
 */

import { describe, expect, it } from "vitest";

import { computeExtractionRepair } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/extraction-repair.js";

describe("computeExtractionRepair", () => {
  it("is empty when the store matches the eligible set", () => {
    const eligible = new Map([
      ["src/a.ts", "h1"],
      ["src/b.ts", "h2"],
    ]);
    const persisted = new Map<string, string | null>([
      ["src/a.ts", "h1"],
      ["src/b.ts", "h2"],
    ]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({ repair: [], orphans: [] });
  });

  it("repairs eligible files the store has never seen", () => {
    const eligible = new Map([
      ["src/a.ts", "h1"],
      ["src/b.ts", "h2"],
    ]);
    const persisted = new Map<string, string | null>([["src/a.ts", "h1"]]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({ repair: ["src/b.ts"], orphans: [] });
  });

  it("repairs files whose content drifted from what was persisted", () => {
    const eligible = new Map([["src/a.ts", "h2"]]);
    const persisted = new Map<string, string | null>([["src/a.ts", "h1"]]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({ repair: ["src/a.ts"], orphans: [] });
  });

  it("treats a null persisted hash as unknown and repairs it", () => {
    // Rows written before the hash column existed. Assuming they are current is
    // the assumption that let the stale graph masquerade as healthy.
    const eligible = new Map([["src/a.ts", "h1"]]);
    const persisted = new Map<string, string | null>([["src/a.ts", null]]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({ repair: ["src/a.ts"], orphans: [] });
  });

  it("reports rows that are no longer eligible as orphans", () => {
    const eligible = new Map([["src/a.ts", "h1"]]);
    const persisted = new Map<string, string | null>([
      ["src/a.ts", "h1"],
      ["src/gone.ts", "h9"],
    ]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({ repair: [], orphans: ["src/gone.ts"] });
  });

  it("repairs everything for a store that is completely empty", () => {
    // The fresh-_vN case: a versioned collection whose DuckDB file was just
    // created has no rows, so the repair set is the whole eligible set.
    const eligible = new Map([
      ["src/a.ts", "h1"],
      ["src/b.ts", "h2"],
    ]);

    expect(computeExtractionRepair(eligible, new Map())).toEqual({
      repair: ["src/a.ts", "src/b.ts"],
      orphans: [],
    });
  });

  it("reports both directions at once", () => {
    const eligible = new Map([
      ["src/kept.ts", "same"],
      ["src/drifted.ts", "new"],
      ["src/added.ts", "fresh"],
    ]);
    const persisted = new Map<string, string | null>([
      ["src/kept.ts", "same"],
      ["src/drifted.ts", "old"],
      ["src/gone.ts", "h"],
    ]);

    expect(computeExtractionRepair(eligible, persisted)).toEqual({
      repair: ["src/drifted.ts", "src/added.ts"],
      orphans: ["src/gone.ts"],
    });
  });
});
