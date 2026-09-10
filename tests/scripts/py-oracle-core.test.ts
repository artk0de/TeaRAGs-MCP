/**
 * The Python oracle's pure core (bd tea-rags-mcp-xumwz). Everything here takes
 * in-memory inputs and returns values: no corpus, no subprocess, no jedi. The
 * comparison rules ARE the measurement, so each one gets a case — a verdict
 * that buckets wrongly does not fail loudly, it just reports a number nobody
 * can act on.
 */
import { describe, expect, it } from "vitest";

import {
  applySuperMroBlindSpot,
  categorizePySite,
  classifyPyVerdict,
  isSuperCallSite,
  mulberry32,
  samplePyRows,
  scoreFan,
  summarizeFanTransitions,
  tallyPyCoverage,
  tallyPyDispatchGap,
  tallyPyFan,
  tallyPyRows,
  type PyFanScore,
  type PyOracleRow,
  type PySiteFacts,
} from "../../scripts/lib/py-oracle-core.js";
import type { CallContext, CallRef, DispatchFanoutOutcome } from "../../src/core/contracts/types/codegraph.js";

const inProject = (relPath: string, symbolId: string | null) =>
  ({
    kind: "inProject",
    answer: { targetRelPath: relPath, targetSymbolId: symbolId },
  }) as const;

const facts = (overrides: Partial<PySiteFacts> = {}): PySiteFacts => ({
  receiverIsAnnotatedParam: false,
  enclosingHasReturnAnnotation: false,
  viaReexport: false,
  viaStarImport: false,
  isSuperCall: false,
  targetIsProperty: false,
  targetIsStaticOrClassMethod: false,
  receiverIsUnion: false,
  isDecoratorSite: false,
  ...overrides,
});

const row = (overrides: Partial<PyOracleRow> = {}): PyOracleRow => ({
  relPath: "pkg/a.py",
  startLine: 1,
  callText: "x.f()",
  receiver: "x",
  member: "f",
  receiverKind: "localVar",
  categories: ["plain"],
  verdict: "match",
  answeredBy: "localBinding",
  chainOutput: "pinned",
  oracleDegraded: false,
  oracleEngine: "jedi",
  ...overrides,
});

describe("classifyPyVerdict", () => {
  it("defers to the shared diff when nothing Python-specific applies", () => {
    expect(
      classifyPyVerdict({
        chain: { targetRelPath: "pkg/b.py", targetSymbolId: "B#f" },
        oracle: inProject("pkg/b.py", "B#f"),
        parseFailed: false,
        classifiedExternal: false,
        oracleTargetNonCallable: false,
      }),
    ).toBe("match");
  });

  it("reports parseFailed ahead of every other rule", () => {
    expect(
      classifyPyVerdict({
        chain: { targetRelPath: "pkg/b.py", targetSymbolId: "B#f" },
        oracle: { kind: "unknown" },
        parseFailed: true,
        classifiedExternal: false,
        oracleTargetNonCallable: false,
      }),
    ).toBe("parseFailed");
  });

  it("calls a site skippedInProject when the classifier said external and truth is in-project", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: inProject("pkg/b.py", "B#f"),
        parseFailed: false,
        classifiedExternal: true,
        oracleTargetNonCallable: false,
      }),
    ).toBe("skippedInProject");
  });

  it("leaves an external classification agreeing with external truth as agreeExternal", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: { kind: "external" },
        parseFailed: false,
        classifiedExternal: true,
        oracleTargetNonCallable: false,
      }),
    ).toBe("agreeExternal");
  });

  it("still reports missed when the chain declined WITHOUT calling the site external", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: inProject("pkg/b.py", "B#f"),
        parseFailed: false,
        classifiedExternal: false,
        oracleTargetNonCallable: false,
      }),
    ).toBe("missed");
  });

  /**
   * `self.table(...)` where `table = None` is a class attribute (z796g). The
   * host substitutes the chain's own symbol id for a `pinUncertain` target, so
   * without this rule the same non-definition scores `missed`, `wrongFile` or
   * even `match` depending only on where the binding happens to live.
   */
  it("buckets an in-project answer whose target is not a definition", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: inProject("pkg/base.py", null),
        parseFailed: false,
        classifiedExternal: false,
        oracleTargetNonCallable: true,
      }),
    ).toBe("oracleNonCallable");
  });

  it("keeps a non-callable target out of match even when the chain named that file", () => {
    expect(
      classifyPyVerdict({
        chain: { targetRelPath: "pkg/base.py", targetSymbolId: "View#table" },
        oracle: inProject("pkg/base.py", "View#table"),
        parseFailed: false,
        classifiedExternal: false,
        oracleTargetNonCallable: true,
      }),
    ).toBe("oracleNonCallable");
  });

  it("outranks skippedInProject — jedi found a binding, not the definition it skipped", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: inProject("pkg/base.py", null),
        parseFailed: false,
        classifiedExternal: true,
        oracleTargetNonCallable: true,
      }),
    ).toBe("oracleNonCallable");
  });

  it("yields to parseFailed — a file nobody read says nothing about its targets", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: inProject("pkg/base.py", null),
        parseFailed: true,
        classifiedExternal: false,
        oracleTargetNonCallable: true,
      }),
    ).toBe("parseFailed");
  });

  it("ignores the flag on an EXTERNAL answer — there is no in-project target to judge", () => {
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: { kind: "external" },
        parseFailed: false,
        classifiedExternal: false,
        oracleTargetNonCallable: true,
      }),
    ).toBe("agreeExternal");
  });
});

describe("categorizePySite", () => {
  it("returns plain when no facts apply", () => {
    expect(categorizePySite(facts(), { receiver: "x", member: "f" })).toEqual(["plain"]);
  });

  it("carries several categories at once — the axis overlaps by construction", () => {
    expect(
      categorizePySite(
        facts({
          receiverIsAnnotatedParam: true,
          enclosingHasReturnAnnotation: true,
        }),
        {
          receiver: "user",
          member: "rename",
        },
      ).sort(),
    ).toEqual(["annotationParam", "annotationReturn"]);
  });

  it("tags a Django manager chain from the receiver text alone", () => {
    expect(categorizePySite(facts(), { receiver: "Device.objects", member: "all" })).toContain("managerQuerySet");
  });

  it("tags a FastAPI Depends injection site", () => {
    expect(
      categorizePySite(facts({ isDecoratorSite: true }), {
        receiver: null,
        member: "Depends",
      }),
    ).toContain("dependsInjection");
  });

  it("never returns plain alongside a specific category", () => {
    expect(
      categorizePySite(facts({ isSuperCall: true }), {
        receiver: "super()",
        member: "__init__",
      }),
    ).toEqual(["superMro"]);
  });

  it("treats missing facts as no information rather than as evidence", () => {
    expect(categorizePySite(undefined, { receiver: "x", member: "f" })).toEqual(["plain"]);
  });
});

describe("isSuperCallSite", () => {
  it("recognises the receiver text the Python walker actually emits", () => {
    // Measured: `classifyReceiverKind` files `super().__init__(name)` under
    // `dynamic`, because SUPER_MARKERS holds "super" and not "super()".
    expect(
      isSuperCallSite({
        receiverKind: "dynamic",
        receiver: "super()",
        facts: undefined,
      }),
    ).toBe(true);
  });

  it("recognises the classifier's own marker", () => {
    expect(
      isSuperCallSite({
        receiverKind: "super",
        receiver: "<super>",
        facts: undefined,
      }),
    ).toBe(true);
  });

  it("believes the Python side's measured fact even when the receiver text is odd", () => {
    expect(
      isSuperCallSite({
        receiverKind: "dynamic",
        receiver: "super(User, self)",
        facts: facts({ isSuperCall: true }),
      }),
    ).toBe(true);
  });

  it("does not fire on a name that merely starts with super", () => {
    expect(
      isSuperCallSite({
        receiverKind: "localVar",
        receiver: "supervisor",
        facts: facts(),
      }),
    ).toBe(false);
  });

  it("does not fire on a bare call with no receiver", () => {
    expect(
      isSuperCallSite({
        receiverKind: "bareCall",
        receiver: null,
        facts: facts(),
      }),
    ).toBe(false);
  });
});

describe("applySuperMroBlindSpot", () => {
  it("withdraws ground truth from a super() site jedi answered out of typeshed", () => {
    expect(
      applySuperMroBlindSpot({
        isSuperCall: true,
        origin: "typeshedStub",
        oracle: { kind: "external" },
        categories: ["plain"],
      }),
    ).toEqual({ oracle: { kind: "unknown" }, categories: ["superMro"] });
  });

  it("does not double-tag superMro when the site facts already carried it", () => {
    expect(
      applySuperMroBlindSpot({
        isSuperCall: true,
        origin: "typeshedStub",
        oracle: { kind: "external" },
        categories: ["superMro"],
      }).categories,
    ).toEqual(["superMro"]);
  });

  it("leaves a NON-super typeshed row external — only super() hits the first-base bug", () => {
    expect(
      applySuperMroBlindSpot({
        isSuperCall: false,
        origin: "typeshedStub",
        oracle: { kind: "external" },
        categories: ["plain"],
      }),
    ).toEqual({ oracle: { kind: "external" }, categories: ["plain"] });
  });

  it("leaves a super() site jedi resolved inside the project alone", () => {
    const oracle = inProject("pkg/base.py", "Base#__init__");
    expect(
      applySuperMroBlindSpot({
        isSuperCall: true,
        origin: "project",
        oracle,
        categories: ["superMro"],
      }),
    ).toEqual({ oracle, categories: ["superMro"] });
  });

  it("withdraws a sitePackages answer when the enclosing class declares two bases", () => {
    expect(
      applySuperMroBlindSpot({
        isSuperCall: true,
        origin: "sitePackages",
        oracle: { kind: "external" },
        categories: ["plain"],
        enclosingBaseCount: 2,
      }),
    ).toEqual({ oracle: { kind: "unknown" }, categories: ["superMro"] });
  });

  it("keeps jedi's verdict on a SINGLE-base class — there the first base IS the MRO", () => {
    expect(
      applySuperMroBlindSpot({
        isSuperCall: true,
        origin: "sitePackages",
        oracle: { kind: "external" },
        categories: ["plain"],
        enclosingBaseCount: 1,
      }),
    ).toEqual({ oracle: { kind: "external" }, categories: ["plain"] });
  });

  it("compares a multi-base site jedi resolved INSIDE the project", () => {
    const oracle = inProject("pkg/base.py", "Base#save");
    expect(
      applySuperMroBlindSpot({
        isSuperCall: true,
        origin: "project",
        oracle,
        categories: ["plain"],
        enclosingBaseCount: 3,
      }),
    ).toEqual({ oracle, categories: ["plain"] });
  });

  it("withdraws stdlib and builtin answers on a multi-base class too", () => {
    for (const origin of ["stdlib", "builtin"] as const) {
      expect(
        applySuperMroBlindSpot({
          isSuperCall: true,
          origin,
          oracle: { kind: "external" },
          categories: ["plain"],
          enclosingBaseCount: 2,
        }).oracle,
      ).toEqual({ kind: "unknown" });
    }
  });

  it("leaves an outsideRepo answer alone — it is not one of the four external origins", () => {
    expect(
      applySuperMroBlindSpot({
        isSuperCall: true,
        origin: "outsideRepo",
        oracle: { kind: "external" },
        categories: ["plain"],
        enclosingBaseCount: 4,
      }),
    ).toEqual({ oracle: { kind: "external" }, categories: ["plain"] });
  });

  it("still withdraws typeshed without a base count — the arity gate only WIDENS the guard", () => {
    expect(
      applySuperMroBlindSpot({
        isSuperCall: true,
        origin: "typeshedStub",
        oracle: { kind: "external" },
        categories: ["plain"],
        enclosingBaseCount: 1,
      }).oracle,
    ).toEqual({ kind: "unknown" });
  });

  it("scores the withdrawn row outside every rate rather than as agreement", () => {
    const adjusted = applySuperMroBlindSpot({
      isSuperCall: true,
      origin: "typeshedStub",
      oracle: { kind: "external" },
      categories: ["plain"],
    });
    expect(
      classifyPyVerdict({
        chain: null,
        oracle: adjusted.oracle,
        parseFailed: false,
        classifiedExternal: false,
        oracleTargetNonCallable: false,
      }),
    ).toBe("bothUnresolved");
    expect(
      classifyPyVerdict({
        chain: { targetRelPath: "pkg/base.py", targetSymbolId: "Base#__init__" },
        oracle: adjusted.oracle,
        parseFailed: false,
        classifiedExternal: false,
        oracleTargetNonCallable: false,
      }),
    ).toBe("chainOnly");
  });
});

describe("tallyPyRows", () => {
  it("excludes degraded rows from mismatchRate but keeps them in sites", () => {
    const tallies = tallyPyRows(
      [
        row({ verdict: "missed", receiverKind: "localVar" }),
        row({
          verdict: "missed",
          receiverKind: "localVar",
          oracleDegraded: true,
        }),
        row({ verdict: "match", receiverKind: "localVar" }),
      ],
      (r) => [r.receiverKind],
    );
    const localVar = tallies.find((t) => t.label === "localVar");
    expect(localVar?.sites).toBe(3);
    expect(localVar?.oracle).toBe(2);
    expect(localVar?.mismatchRate).toBeCloseTo(0.5, 10);
  });

  it("withholds oracleNonCallable rows from the rates but keeps them in sites", () => {
    // Same treatment as a degraded parse: the row carries no ground truth, so
    // counting it would let a jedi limitation read as a resolver defect.
    const tallies = tallyPyRows(
      [row({ verdict: "oracleNonCallable" }), row({ verdict: "missed" }), row({ verdict: "match" })],
      (r) => [r.receiverKind],
    );
    const localVar = tallies.find((t) => t.label === "localVar");
    expect(localVar?.sites).toBe(3);
    expect(localVar?.oracle).toBe(2);
    expect(localVar?.mismatchRate).toBeCloseTo(0.5, 10);
  });

  it("gives degraded rows their own label so the loss is readable", () => {
    const tallies = tallyPyRows([row({ oracleDegraded: true })], (r) => (r.oracleDegraded ? ["oracleDegraded"] : []));
    expect(tallies.find((t) => t.label === "oracleDegraded")?.sites).toBe(1);
  });

  it("sorts by site count descending, then by label", () => {
    const tallies = tallyPyRows(
      [row({ receiverKind: "bareCall" }), row({ receiverKind: "chain" }), row({ receiverKind: "chain" })],
      (r) => [r.receiverKind],
    );
    expect(tallies.map((t) => t.label)).toEqual(["chain", "bareCall"]);
  });
});

describe("samplePyRows", () => {
  it("is stable for one seed and different for another", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row({ startLine: i, verdict: "missed" }));
    const a = samplePyRows(rows, "missed", 5, 42).map((r) => r.startLine);
    expect(samplePyRows(rows, "missed", 5, 42).map((r) => r.startLine)).toEqual(a);
    expect(samplePyRows(rows, "missed", 5, 43).map((r) => r.startLine)).not.toEqual(a);
  });

  it("does NOT return the first N — first-N samples the corpus's directory order", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row({ startLine: i, verdict: "missed" }));
    expect(samplePyRows(rows, "missed", 5, 7).map((r) => r.startLine)).not.toEqual([0, 1, 2, 3, 4]);
  });

  it("returns every row when the corpus has fewer than requested", () => {
    expect(samplePyRows([row({ verdict: "phantom" })], "phantom", 25, 1)).toHaveLength(1);
  });

  it("selects only the asked-for verdict", () => {
    const rows = [row({ verdict: "missed" }), row({ verdict: "match" })];
    expect(samplePyRows(rows, "missed", 10, 1).every((r) => r.verdict === "missed")).toBe(true);
  });
});

describe("mulberry32", () => {
  it("produces the same stream for the same seed", () => {
    const draw = (seed: number) => Array.from({ length: 4 }, mulberry32(seed));
    expect(draw(1)).toEqual(draw(1));
    expect(draw(1)).not.toEqual(draw(2));
  });
});

describe("tallyPyCoverage", () => {
  it("counts the two verdicts tallyPyRows folds away or drops", () => {
    // `skippedInProject` is folded into `missed` by the receiver tally and
    // `parseFailed` is dropped from it entirely, so neither can be read back
    // out of the per-label rows. The baseline appendix reports both.
    const counts = tallyPyCoverage([
      row({ verdict: "skippedInProject" }),
      row({ verdict: "skippedInProject" }),
      row({ verdict: "parseFailed" }),
      row({ verdict: "oracleNonCallable" }),
      row({ verdict: "oracleNonCallable" }),
      row({ verdict: "oracleNonCallable" }),
      row({ verdict: "match" }),
    ]);
    expect(counts.skippedInProject).toBe(2);
    expect(counts.parseFailed).toBe(1);
    expect(counts.oracleNonCallable).toBe(3);
  });

  it("counts unlocated sites by shape, sorted, and omits shapes nobody hit", () => {
    const counts = tallyPyCoverage([
      row({ unlocatedShape: "multiLineCall" }),
      row({ unlocatedShape: "decoratorBare" }),
      row({ unlocatedShape: "multiLineCall" }),
      row(),
    ]);
    expect(counts.unlocated).toBe(3);
    expect(Object.entries(counts.unlocatedByShape)).toEqual([
      ["decoratorBare", 1],
      ["multiLineCall", 2],
    ]);
  });

  it("returns zeros rather than absent keys on an empty corpus", () => {
    expect(tallyPyCoverage([])).toEqual({
      skippedInProject: 0,
      parseFailed: 0,
      oracleNonCallable: 0,
      unlocated: 0,
      unlocatedByShape: {},
    });
  });
});

/**
 * The dispatch layer's own scoring (bd tea-rags-mcp-w205u, E4.0.3). Production
 * consults `resolveDispatch` BEFORE the exact chain and lets its answer replace
 * the chain's, so these four outcomes decide which of the two bars a site is
 * measured against — and getting the split wrong would move recall without any
 * resolver changing.
 */
const dispatcher = (outcome: DispatchFanoutOutcome) => ({
  resolveDispatch: (_call: CallRef, _ctx: CallContext): DispatchFanoutOutcome => outcome,
});
const call = { member: "f", receiver: "x", callText: "x.f()", startLine: 1 } as unknown as CallRef;
const ctx = {} as unknown as CallContext;
const edge = (relPath: string, symbolId: string | null, confidence: number) => ({
  sourceSymbolId: null,
  targetRelPath: relPath,
  targetSymbolId: symbolId,
  edgeKind: "cone" as const,
  confidence,
});

describe("scoreFan", () => {
  it("reads an empty fan-out as `none`, the outcome that lets the exact chain answer", () => {
    expect(scoreFan(dispatcher({ kind: "edges", edges: [] }), call, ctx)).toEqual({
      kind: "none",
      fan: [],
      fanSize: 0,
      fanConfidence: null,
      single: null,
    });
  });

  it("reads a resolver with no dispatch channel at all as `none`", () => {
    expect(scoreFan({}, call, ctx).kind).toBe("none");
  });

  it("splits ONE surviving target off as `single` — a confidence-1 edge is a 1:1 claim", () => {
    const outcome = scoreFan(dispatcher({ kind: "edges", edges: [edge("pkg/b.py", "B#f", 1)] }), call, ctx);
    expect(outcome.kind).toBe("single");
    expect(outcome.single).toEqual({ targetRelPath: "pkg/b.py", targetSymbolId: "B#f" });
    expect(outcome.fanConfidence).toBe(1);
  });

  it("books m>1 edges as `fan`, sorted and deduped, carrying the per-edge confidence", () => {
    const outcome = scoreFan(
      dispatcher({
        kind: "edges",
        edges: [edge("pkg/c.py", "C#f", 0.5), edge("pkg/b.py", "B#f", 0.5), edge("pkg/c.py", "C#f", 0.5)],
      }),
      call,
      ctx,
    );
    expect(outcome.kind).toBe("fan");
    expect(outcome.fan).toEqual(["pkg/b.py#B#f", "pkg/c.py#C#f"]);
    expect(outcome.fanSize).toBe(2);
    expect(outcome.fanConfidence).toBe(0.5);
    expect(outcome.single).toBeNull();
  });

  it("books m edges that name ONE target as `single` — a 1:1 comparison has one answer", () => {
    const outcome = scoreFan(
      dispatcher({ kind: "edges", edges: [edge("pkg/b.py", "B#f", 0.5), edge("pkg/b.py", "B#f", 0.5)] }),
      call,
      ctx,
    );
    expect(outcome.kind).toBe("single");
    expect(outcome.fanSize).toBe(1);
  });

  it("carries the candidate count as the SIZE of an over-cap decision, and no fan", () => {
    // `ambiguous` is the decision not to fan at all: no edges, no fallback.
    const outcome = scoreFan(dispatcher({ kind: "ambiguous", member: "f", candidateCount: 240 }), call, ctx);
    expect(outcome).toEqual({ kind: "ambiguous", fan: [], fanSize: 240, fanConfidence: null, single: null });
  });
});

const fanScore = (overrides: Partial<PyFanScore> = {}): PyFanScore => ({
  kind: "fan",
  fan: ["pkg/b.py#B#f", "pkg/c.py#C#f"],
  fanSize: 2,
  fanConfidence: 0.5,
  single: null,
  hitsOracle: true,
  oracleInProject: true,
  ...overrides,
});

describe("tallyPyFan", () => {
  it("skips a row the walk scored without the layer — an absent outcome is not a `none`", () => {
    expect(tallyPyFan([row({}), row({})], (r) => [r.receiverKind])).toEqual([]);
  });

  it("counts `ambiguous` as a recall MISS in the fan denominator (D4)", () => {
    const [tally] = tallyPyFan(
      [
        row({ dispatch: fanScore() }),
        row({ dispatch: fanScore({ kind: "ambiguous", fan: [], fanSize: 240, hitsOracle: false }) }),
      ],
      (r) => [r.receiverKind],
    );
    expect(tally.fanScored).toBe(2);
    expect(tally.fanHits).toBe(1);
    expect(tally.recallAtFan).toBeCloseTo(0.5, 10);
  });

  it("keeps `ambiguous` OUT of fanSize* and precisionProxy — there is no fan to size", () => {
    const [tally] = tallyPyFan(
      [
        row({ dispatch: fanScore({ fanSize: 4, fan: ["a#a", "b#b", "c#c", "d#d"] }) }),
        row({ dispatch: fanScore({ kind: "ambiguous", fan: [], fanSize: 240, hitsOracle: false }) }),
      ],
      (r) => [r.receiverKind],
    );
    expect(tally.fanSizeMean).toBe(4);
    expect(tally.fanSizeP50).toBe(4);
    expect(tally.precisionProxy).toBeCloseTo(0.25, 10);
  });

  it("uses the floor-index percentile convention `signal-utils` uses", () => {
    // Sizes 1..10: floor(10 * 0.5) = 5 → the 6th, and floor(10 * 0.95) = 9 → the 10th.
    const rows = Array.from({ length: 10 }, (_, index) =>
      row({ dispatch: fanScore({ fanSize: index + 1, hitsOracle: false }) }),
    );
    const [tally] = tallyPyFan(rows, (r) => [r.receiverKind]);
    expect(tally.fanSizeP50).toBe(6);
    expect(tally.fanSizeP95).toBe(10);
  });

  it("divides precisionProxy by the fan sites, so a ten-edge hit scores 0.1", () => {
    const [tally] = tallyPyFan([row({ dispatch: fanScore({ fanSize: 10 }) })], (r) => [r.receiverKind]);
    expect(tally.precisionProxy).toBeCloseTo(0.1, 10);
  });

  it("keeps a fan row with no in-project oracle target out of the recall denominator", () => {
    const [tally] = tallyPyFan([row({ dispatch: fanScore({ oracleInProject: false, hitsOracle: false }) })], (r) => [
      r.receiverKind,
    ]);
    expect(tally.fanSites).toBe(1);
    expect(tally.fanScored).toBe(0);
    expect(tally.recallAtFan).toBe(0);
  });

  it("counts a fan that MISSED an in-project target as a fan phantom", () => {
    const [tally] = tallyPyFan(
      [row({ dispatch: fanScore({ hitsOracle: false }) }), row({ dispatch: fanScore() })],
      (r) => [r.receiverKind],
    );
    expect(tally.fanPhantom).toBe(1);
    expect(tally.fanPhantomRate).toBeCloseTo(0.5, 10);
  });

  it("prints both ambiguous denominators — the whole population and the fanned one", () => {
    const [tally] = tallyPyFan(
      [
        row({ dispatch: fanScore({ kind: "ambiguous", fan: [], fanSize: 20, hitsOracle: false }) }),
        row({ dispatch: fanScore() }),
        row({ dispatch: fanScore({ kind: "none", fan: [], fanSize: 0, hitsOracle: false }) }),
        row({ dispatch: fanScore({ kind: "single", fan: ["pkg/b.py#B#f"], fanSize: 1 }) }),
      ],
      (r) => [r.receiverKind],
    );
    expect(tally.oneToOneSites).toBe(2);
    expect(tally.singleSites).toBe(1);
    expect(tally.ambiguousShare).toBeCloseTo(0.25, 10);
    expect(tally.ambiguousShareOfFanned).toBeCloseTo(0.5, 10);
  });
});

describe("tallyPyDispatchGap", () => {
  it("counts an exact MATCH the fan-out replaced, apart from one the cap threw away", () => {
    const gap = tallyPyDispatchGap([
      row({ verdict: "bothUnresolved", exactVerdict: "match", dispatch: fanScore() }),
      row({
        verdict: "bothUnresolved",
        exactVerdict: "match",
        dispatch: fanScore({ kind: "ambiguous", fan: [], fanSize: 99, hitsOracle: false }),
      }),
      row({ verdict: "match", exactVerdict: "match", dispatch: fanScore({ kind: "single", fanSize: 1 }) }),
    ]);
    expect(gap).toEqual({
      exactReplacedByFan: 1,
      exactReplacedByAmbiguous: 1,
      fanRescued: 0,
      exactReplacedBySingle: 0,
      singleRescued: 0,
      dispatchAnswered: 3,
    });
  });

  it("counts a single-target cone answer that LOST a match the chain had", () => {
    // The same loss as a fan replacement, through the other door: a `single`
    // outcome replaces the chain's answer while staying in the 1:1 columns.
    const gap = tallyPyDispatchGap([
      row({ verdict: "wrongFile", exactVerdict: "match", dispatch: fanScore({ kind: "single", fanSize: 1 }) }),
      row({ verdict: "match", exactVerdict: "wrongFile", dispatch: fanScore({ kind: "single", fanSize: 1 }) }),
    ]);
    expect(gap.exactReplacedBySingle).toBe(1);
    expect(gap.singleRescued).toBe(1);
  });

  it("counts a site the chain declined and the fan carried as rescued, `skippedInProject` included", () => {
    const gap = tallyPyDispatchGap([
      row({ verdict: "bothUnresolved", exactVerdict: "missed", dispatch: fanScore() }),
      row({ verdict: "bothUnresolved", exactVerdict: "skippedInProject", dispatch: fanScore() }),
      // Declined, but the fan does not carry the oracle's target either.
      row({ verdict: "bothUnresolved", exactVerdict: "missed", dispatch: fanScore({ hitsOracle: false }) }),
    ]);
    expect(gap.fanRescued).toBe(2);
  });

  it("ignores a row the layer never touched", () => {
    expect(tallyPyDispatchGap([row({}), row({ dispatch: fanScore({ kind: "none", fan: [], fanSize: 0 }) })])).toEqual({
      exactReplacedByFan: 0,
      exactReplacedByAmbiguous: 0,
      fanRescued: 0,
      exactReplacedBySingle: 0,
      singleRescued: 0,
      dispatchAnswered: 0,
    });
  });
});

describe("summarizeFanTransitions", () => {
  it("groups by `before -> after`, reading an absent outcome as `none`", () => {
    const summary = summarizeFanTransitions([
      { before: {}, after: { dispatchOutcome: "fan", fanSize: 3 } },
      { before: {}, after: { dispatchOutcome: "fan", fanSize: 2 } },
      { before: { dispatchOutcome: "fan", fanSize: 2 }, after: { dispatchOutcome: "single", fanSize: 1 } },
      { before: { dispatchOutcome: "ambiguous", fanSize: 99 }, after: { dispatchOutcome: "fan", fanSize: 4 } },
    ]);
    expect(summary.transitions).toEqual([
      ["none -> fan", 2],
      ["ambiguous -> fan", 1],
      ["fan -> single", 1],
    ]);
  });

  it("histograms the size delta only where BOTH sides fanned", () => {
    const summary = summarizeFanTransitions([
      { before: { dispatchOutcome: "fan", fanSize: 2 }, after: { dispatchOutcome: "fan", fanSize: 5 } },
      { before: { dispatchOutcome: "fan", fanSize: 4 }, after: { dispatchOutcome: "fan", fanSize: 1 } },
      { before: { dispatchOutcome: "fan", fanSize: 3 }, after: { dispatchOutcome: "fan", fanSize: 3 } },
      { before: {}, after: { dispatchOutcome: "fan", fanSize: 9 } },
    ]);
    expect(summary.sizeDeltas).toEqual([
      [-3, 1],
      [0, 1],
      [3, 1],
    ]);
  });
});

describe("tallyPyRows with the dispatch layer on", () => {
  it("withholds a fan and an over-cap row from the 1:1 rates but keeps them in sites", () => {
    // A fan edge is a hypothesis set at `discount / m` and an `ambiguous` row is
    // no edge at all, so neither carries a 1:1 verdict to score (D3).
    const tallies = tallyPyRows(
      [
        row({ verdict: "match" }),
        row({ verdict: "missed" }),
        row({ verdict: "bothUnresolved", dispatch: fanScore() }),
        row({
          verdict: "bothUnresolved",
          dispatch: fanScore({ kind: "ambiguous", fan: [], fanSize: 40, hitsOracle: false }),
        }),
      ],
      (r) => [r.receiverKind],
    );
    const localVar = tallies.find((t) => t.label === "localVar");
    expect(localVar?.sites).toBe(4);
    expect(localVar?.oracle).toBe(2);
  });

  it("scores a `single` row in the 1:1 columns — it IS the answer production books", () => {
    const tallies = tallyPyRows(
      [row({ verdict: "match", dispatch: fanScore({ kind: "single", fan: ["pkg/b.py#B#f"], fanSize: 1 }) })],
      (r) => [r.receiverKind],
    );
    expect(tallies.find((t) => t.label === "localVar")?.oracle).toBe(1);
  });
});
