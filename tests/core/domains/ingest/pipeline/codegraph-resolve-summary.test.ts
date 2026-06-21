import { describe, expect, it } from "vitest";

import type { ResolveRunStatsRow } from "../../../../../src/core/contracts/types/codegraph.js";
import { summarizeCodegraphResolve } from "../../../../../src/core/domains/ingest/pipeline/status-module.js";

// bd tea-rags-mcp-cnqrg — the per-(language, receiverKind) cg_run_stats rows fold
// into the status DTO: aggregate over all rows + a per-language breakdown that
// reuses the get_index_metrics min-share display rule (MIN_LANGUAGE_SHARE = 5%).
const row = (
  language: string,
  receiverKind: string,
  attempted: number,
  resolved: number,
  externalSkipped = 0,
): ResolveRunStatsRow => ({ language, receiverKind, attempted, resolved, externalSkipped });

describe("summarizeCodegraphResolve (cnqrg)", () => {
  it("returns undefined when there are no rows", () => {
    expect(summarizeCodegraphResolve([])).toBeUndefined();
  });

  it("aggregates every row and breaks resolveSuccessRate down per language", () => {
    // typescript: 80/100 attempted (10 external) → 70/90; ruby: 30/50 (no external) → 30/50.
    const summary = summarizeCodegraphResolve([
      row("typescript", "constant", 100, 80, 10),
      row("ruby", "constant", 50, 30, 0),
    ]);
    expect(summary).toBeDefined();
    expect(summary?.callsAttempted).toBe(150);
    expect(summary?.callsResolved).toBe(110);
    expect(summary?.callsExternalSkipped).toBe(10);
    // aggregate denominator excludes external: 110 / (150 − 10) = 110/140.
    expect(summary?.resolveSuccessRate).toBeCloseTo(110 / 140, 6);

    const byLang = summary?.byLanguage ?? [];
    // Sorted by callsAttempted desc → typescript first.
    expect(byLang.map((l) => l.language)).toEqual(["typescript", "ruby"]);
    const ts = byLang.find((l) => l.language === "typescript");
    expect(ts).toMatchObject({ callsAttempted: 100, callsResolved: 80, callsExternalSkipped: 10 });
    expect(ts?.resolveSuccessRate).toBeCloseTo(80 / 90, 6);
    const ruby = byLang.find((l) => l.language === "ruby");
    expect(ruby?.resolveSuccessRate).toBeCloseTo(30 / 50, 6);
  });

  it("drops a language whose call-site share is below the metrics min-share floor", () => {
    // python = 3 / (100 + 3) ≈ 2.9% < 5% → omitted from the breakdown, but still
    // counted in the aggregate totals.
    const summary = summarizeCodegraphResolve([
      row("typescript", "constant", 100, 90, 0),
      row("python", "constant", 3, 1, 0),
    ]);
    expect(summary?.callsAttempted).toBe(103); // aggregate keeps python
    // After dropping python only typescript survives → ≤1 language → no breakdown.
    expect(summary?.byLanguage).toBeUndefined();
  });

  it("omits the breakdown when only one language survives (aggregate already conveys it)", () => {
    const summary = summarizeCodegraphResolve([row("typescript", "constant", 100, 90, 0)]);
    expect(summary?.resolveSuccessRate).toBeCloseTo(90 / 100, 6);
    expect(summary?.byLanguage).toBeUndefined();
  });

  it("excludes unlabeled rows from the per-language view but keeps them in the aggregate", () => {
    const summary = summarizeCodegraphResolve([
      row("", "constant", 40, 10, 0), // pre-cnqrg / direct-mode — aggregate only
      row("typescript", "constant", 100, 80, 0),
      row("ruby", "constant", 60, 40, 0),
    ]);
    expect(summary?.callsAttempted).toBe(200); // unlabeled 40 counted
    const langs = (summary?.byLanguage ?? []).map((l) => l.language);
    expect(langs).toEqual(["typescript", "ruby"]); // no "" entry
  });
});
