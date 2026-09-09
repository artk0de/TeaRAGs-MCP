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
  tallyPyCoverage,
  tallyPyRows,
  type PyOracleRow,
  type PySiteFacts,
} from "../../scripts/lib/py-oracle-core.js";

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
      }),
    ).toBe("missed");
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
      }),
    ).toBe("bothUnresolved");
    expect(
      classifyPyVerdict({
        chain: { targetRelPath: "pkg/base.py", targetSymbolId: "Base#__init__" },
        oracle: adjusted.oracle,
        parseFailed: false,
        classifiedExternal: false,
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
      row({ verdict: "match" }),
    ]);
    expect(counts.skippedInProject).toBe(2);
    expect(counts.parseFailed).toBe(1);
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
      unlocated: 0,
      unlocatedByShape: {},
    });
  });
});
