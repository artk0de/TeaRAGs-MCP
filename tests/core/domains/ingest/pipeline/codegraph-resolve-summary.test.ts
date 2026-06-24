import { afterEach, describe, expect, it } from "vitest";

import type { ResolveRunStatsRow } from "../../../../../src/core/contracts/types/codegraph.js";
import { summarizeCodegraphResolve } from "../../../../../src/core/domains/ingest/pipeline/status-module.js";
import { setDebug } from "../../../../../src/core/infra/runtime.js";

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

// bd tea-rags-mcp-7m5xz — the per-(language, receiverKind) rows ALSO fold into a
// per-receiver-kind breakdown so cai0 phases can rank which receiver-kind bucket
// is the largest unresolved gap per language. Placement MIRRORS the byLanguage
// suppression: >1 language → byReceiverKind on each byLanguage row (precise
// lang×kind); =1 language → top-level summary.byReceiverKind.
describe("summarizeCodegraphResolve receiver-kind breakdown (7m5xz)", () => {
  it("attaches byReceiverKind to each byLanguage row and leaves top-level undefined when >1 language", () => {
    const summary = summarizeCodegraphResolve([
      row("typescript", "selfMember", 130, 125, 0),
      row("typescript", "constant", 100, 60, 0),
      row("ruby", "constant", 50, 40, 0),
      row("ruby", "selfMember", 30, 20, 0),
    ]);
    expect(summary?.byReceiverKind).toBeUndefined(); // top-level NOT set for multi-language

    const byLang = summary?.byLanguage ?? [];
    const ts = byLang.find((l) => l.language === "typescript");
    expect(ts?.byReceiverKind?.map((k) => k.receiverKind)).toEqual(["selfMember", "constant"]);
    const tsSelf = ts?.byReceiverKind?.find((k) => k.receiverKind === "selfMember");
    expect(tsSelf).toMatchObject({ attempted: 130, resolved: 125, externalSkipped: 0 });
    expect(tsSelf?.resolveSuccessRate).toBeCloseTo(125 / 130, 6);

    const ruby = byLang.find((l) => l.language === "ruby");
    expect(ruby?.byReceiverKind?.map((k) => k.receiverKind)).toEqual(["constant", "selfMember"]);
  });

  it("sets top-level byReceiverKind and leaves byLanguage undefined when exactly 1 language", () => {
    const summary = summarizeCodegraphResolve([
      row("typescript", "selfMember", 130, 125, 0),
      row("typescript", "constant", 100, 60, 0),
    ]);
    expect(summary?.byLanguage).toBeUndefined(); // existing suppression intact
    const kinds = summary?.byReceiverKind ?? [];
    expect(kinds.map((k) => k.receiverKind)).toEqual(["selfMember", "constant"]);
    const self = kinds.find((k) => k.receiverKind === "selfMember");
    expect(self).toMatchObject({ attempted: 130, resolved: 125, externalSkipped: 0 });
    expect(self?.resolveSuccessRate).toBeCloseTo(125 / 130, 6); // ~0.96
  });

  it("omits a zero-attempt receiver kind from the breakdown", () => {
    const summary = summarizeCodegraphResolve([
      row("typescript", "selfMember", 100, 90, 0),
      row("typescript", "ghostKind", 0, 0, 0),
    ]);
    const kinds = summary?.byReceiverKind ?? [];
    expect(kinds.map((k) => k.receiverKind)).toEqual(["selfMember"]); // ghostKind omitted
  });

  it("sorts receiver kinds by attempted desc", () => {
    const summary = summarizeCodegraphResolve([
      row("typescript", "constant", 30, 20, 0),
      row("typescript", "selfMember", 200, 180, 0),
      row("typescript", "instanceMember", 90, 50, 0),
    ]);
    expect((summary?.byReceiverKind ?? []).map((k) => k.receiverKind)).toEqual([
      "selfMember",
      "instanceMember",
      "constant",
    ]);
  });

  it("excludes externalSkipped from the per-kind resolveSuccessRate denominator", () => {
    const summary = summarizeCodegraphResolve([
      // selfMember: no external → 125 / (130 − 0) ≈ 0.96
      row("typescript", "selfMember", 130, 125, 0),
      // constant: 20 external → 60 / (100 − 20) = 60/80 = 0.75
      row("typescript", "constant", 100, 60, 20),
    ]);
    const kinds = summary?.byReceiverKind ?? [];
    const self = kinds.find((k) => k.receiverKind === "selfMember");
    expect(self?.resolveSuccessRate).toBeCloseTo(125 / 130, 6);
    const constant = kinds.find((k) => k.receiverKind === "constant");
    expect(constant).toMatchObject({ attempted: 100, resolved: 60, externalSkipped: 20 });
    expect(constant?.resolveSuccessRate).toBeCloseTo(60 / 80, 6);
  });
});

// bd tea-rags-mcp-7m5xz follow-up — byReceiverKind is verbose; it appears ONLY
// under DEBUG. By default get_index_status shows the short form (aggregate +
// byLanguage) exactly as before this session. vitest.setup sets DEBUG=true
// globally, so the regression cases above run under debug; here we explicitly
// flip it off, assert byReceiverKind is absent (nested AND top-level), then
// restore so no leak reaches other tests.
describe("summarizeCodegraphResolve byReceiverKind DEBUG gate (7m5xz)", () => {
  afterEach(() => {
    setDebug(true); // vitest.setup baseline — restore so other files see DEBUG on
  });

  it("omits byReceiverKind entirely when DEBUG is off (top-level, single language)", () => {
    setDebug(false);
    const summary = summarizeCodegraphResolve([
      row("typescript", "selfMember", 130, 125, 0),
      row("typescript", "constant", 100, 60, 0),
    ]);
    // Short form intact: aggregate present, byLanguage suppressed (≤1 language).
    // resolveSuccessRate is DEBUG-only now (Variant B) → absent here; the
    // always-on inProjectEdgeRecall carries the same value when nothing is
    // external / unresolvable / no-in-project-def.
    expect(summary?.resolveSuccessRate).toBeUndefined();
    expect(summary?.inProjectEdgeRecall).toBeCloseTo(185 / 230, 6);
    expect(summary?.byReceiverKind).toBeUndefined();
  });

  it("omits byReceiverKind on every byLanguage row when DEBUG is off (multi-language)", () => {
    setDebug(false);
    const summary = summarizeCodegraphResolve([
      row("typescript", "selfMember", 130, 125, 0),
      row("typescript", "constant", 100, 60, 0),
      row("ruby", "constant", 50, 40, 0),
      row("ruby", "selfMember", 30, 20, 0),
    ]);
    expect(summary?.byReceiverKind).toBeUndefined(); // top-level absent
    const byLang = summary?.byLanguage ?? [];
    expect(byLang.map((l) => l.language)).toEqual(["typescript", "ruby"]); // short form intact
    for (const l of byLang) {
      expect(l.byReceiverKind).toBeUndefined(); // nested absent
    }
  });

  it("populates byReceiverKind when DEBUG is on (regression — gate does not break the feature)", () => {
    setDebug(true);
    const summary = summarizeCodegraphResolve([
      row("typescript", "selfMember", 130, 125, 0),
      row("typescript", "constant", 100, 60, 0),
    ]);
    expect((summary?.byReceiverKind ?? []).map((k) => k.receiverKind)).toEqual(["selfMember", "constant"]);
  });
});

// Variant B — inProjectEdgeRecall is the always-on graph-completeness metric;
// resolveSuccessRate (raw resolver capability, denominator-polluted by
// no-in-project-def calls) drops to DEBUG-only since it misleads a casual reader.
const rowN = (
  language: string,
  receiverKind: string,
  attempted: number,
  resolved: number,
  externalSkipped: number,
  noInProjectDef: number,
): ResolveRunStatsRow => ({ language, receiverKind, attempted, resolved, externalSkipped, noInProjectDef });

describe("summarizeCodegraphResolve inProjectEdgeRecall (Variant B)", () => {
  afterEach(() => {
    setDebug(true); // vitest.setup baseline — restore so other files see DEBUG on
  });

  it("computes inProjectEdgeRecall excluding no-in-project-def misses", () => {
    // attempted 100, resolved 80, external 0, noInProjectDef 15 →
    // genuine miss 20; missWithInProjectDef = 20 − 15 = 5; recall = 80/(80+5).
    const summary = summarizeCodegraphResolve([rowN("typescript", "constant", 100, 80, 0, 15)]);
    expect(summary?.inProjectEdgeRecall).toBeCloseTo(80 / 85, 6);
    expect(summary?.callsNoInProjectDef).toBe(15);
  });

  it("includes inProjectEdgeRecall ALWAYS but resolveSuccessRate ONLY under DEBUG", () => {
    setDebug(false);
    const off = summarizeCodegraphResolve([rowN("typescript", "constant", 100, 80, 0, 15)]);
    expect(off?.inProjectEdgeRecall).toBeCloseTo(80 / 85, 6); // always present
    expect(off?.callsNoInProjectDef).toBe(15);
    expect(off?.resolveSuccessRate).toBeUndefined(); // hidden from the casual reader

    setDebug(true);
    const on = summarizeCodegraphResolve([rowN("typescript", "constant", 100, 80, 0, 15)]);
    expect(on?.resolveSuccessRate).toBeCloseTo(80 / 100, 6); // surfaced under DEBUG
    expect(on?.inProjectEdgeRecall).toBeCloseTo(80 / 85, 6);
  });

  it("defaults noInProjectDef to 0 for pre-migration rows (recall == raw capability)", () => {
    // A row without the field (old persisted shape) → every genuine miss counts
    // as a recall hole, so recall collapses to resolved/(attempted−external).
    const summary = summarizeCodegraphResolve([row("typescript", "constant", 100, 80, 0)]);
    expect(summary?.callsNoInProjectDef).toBe(0);
    expect(summary?.inProjectEdgeRecall).toBeCloseTo(80 / 100, 6);
  });
});

// Phase D (tea-rags-mcp-zhutn) — surface the recall split PER receiver-kind so
// the dominant recall-hole bucket is data-driven, not estimated. byReceiverKind
// is DEBUG-only, so these per-kind fields ride alongside the existing per-kind
// resolveSuccessRate under DEBUG.
describe("summarizeCodegraphResolve per-kind inProjectEdgeRecall (Phase D)", () => {
  afterEach(() => {
    setDebug(true); // vitest.setup baseline — restore so other files see DEBUG on
  });

  it("attaches inProjectEdgeRecall + callsNoInProjectDef to each byReceiverKind row", () => {
    setDebug(true);
    // chain: attempted 100, resolved 40, noInProjectDef 20 → genuine miss 60;
    // missWithInProjectDef = 60 − 20 = 40; recall = 40/(40+40) = 0.5.
    const summary = summarizeCodegraphResolve([rowN("ruby", "chain", 100, 40, 0, 20)]);
    const chain = (summary?.byReceiverKind ?? []).find((k) => k.receiverKind === "chain");
    expect(chain?.callsNoInProjectDef).toBe(20);
    expect(chain?.inProjectEdgeRecall).toBeCloseTo(40 / 80, 6);
  });
});

// Phase B1 (tea-rags-mcp-zyoqs) — exact-vs-fan-out edge-kind distribution is a
// precision-confidence signal: exact edges are pinned to one target; cone /
// poly-base / dynamic are over-approximations (confidence < 1).
describe("summarizeCodegraphResolve edgeKinds (Phase B1)", () => {
  it("attaches an edge-kind breakdown with exactRatio when edge counts are provided", () => {
    const summary = summarizeCodegraphResolve(
      [row("ruby", "constant", 100, 80, 0)],
      [
        { edgeKind: "exact", count: 80 },
        { edgeKind: "cone", count: 15 },
        { edgeKind: "poly-base", count: 5 },
      ],
    );
    expect(summary?.edgeKinds).toMatchObject({ exact: 80, cone: 15, polyBase: 5, dynamic: 0, registry: 0, total: 100 });
    expect(summary?.edgeKinds?.exactRatio).toBeCloseTo(0.8, 6);
  });

  it("omits edgeKinds when no edge counts are provided (back-compat)", () => {
    const summary = summarizeCodegraphResolve([row("ruby", "constant", 100, 80, 0)]);
    expect(summary?.edgeKinds).toBeUndefined();
  });
});
