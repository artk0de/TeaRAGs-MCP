import { describe, expect, it } from "vitest";

import {
  diffResolution,
  findUncoveredCategories,
  flagTrackBPriorities,
  formatOracleTable,
  tallyBy,
  tallyChainOutput,
  type OracleOutcome,
  type OracleRow,
  type OracleVerdict,
} from "../../scripts/ts-codegraph-typechecker-oracle.js";

/** One call-site row, defaulted so each test states only the axis it exercises. */
function row(overrides: Partial<OracleRow> = {}): OracleRow {
  return {
    relPath: "src/a.ts",
    startLine: 1,
    callText: "run()",
    receiverKind: "bareCall",
    categories: ["plain"],
    verdict: "match",
    chainOutput: "pinned",
    ...overrides,
  };
}

/** N rows sharing one verdict — the tally inputs read as counts, not fixtures. */
function rows(verdict: OracleVerdict, count: number, overrides: Partial<OracleRow> = {}): OracleRow[] {
  return Array.from({ length: count }, () => row({ verdict, ...overrides }));
}

/** The checker resolved the call to an in-project declaration. */
function inProject(targetRelPath: string, targetSymbolId: string | null): OracleOutcome {
  return { kind: "inProject", answer: { targetRelPath, targetSymbolId } };
}

describe("diffResolution", () => {
  it("reports match when both sides name the same file and the same symbol", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: "Repo#fetch" };

    expect(diffResolution(chain, inProject("src/repo.ts", "Repo#fetch"))).toEqual("match");
  });

  it("reports fileOnly when both sides name the same file but disagree on the symbol", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: "Repo#fetch" };

    expect(diffResolution(chain, inProject("src/repo.ts", "Cache#fetch"))).toEqual("fileOnly");
  });

  it("reports fileOnly when the file agrees and only one side pinned a symbol", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: null };

    expect(diffResolution(chain, inProject("src/repo.ts", "Repo#fetch"))).toEqual("fileOnly");
  });

  it("reports match when the file agrees and neither side pinned a symbol", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: null };

    expect(diffResolution(chain, inProject("src/repo.ts", null))).toEqual("match");
  });

  it("reports wrongFile when the two sides name different files", () => {
    const chain = { targetRelPath: "src/cache.ts", targetSymbolId: "Cache#fetch" };

    expect(diffResolution(chain, inProject("src/repo.ts", "Repo#fetch"))).toEqual("wrongFile");
  });

  it("reports missed when the type checker resolved a call the chain declined", () => {
    expect(diffResolution(null, inProject("src/repo.ts", "Repo#fetch"))).toEqual("missed");
  });

  it("reports phantom when the chain claims an in-project target the checker places outside the project", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: "Repo#map" };

    expect(diffResolution(chain, { kind: "external" })).toEqual("phantom");
  });

  it("reports agreeExternal when both sides leave an out-of-project call alone", () => {
    expect(diffResolution(null, { kind: "external" })).toEqual("agreeExternal");
  });

  it("reports chainOnly when the chain resolved a call the type checker has no answer for", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: "Repo#fetch" };

    expect(diffResolution(chain, { kind: "unknown" })).toEqual("chainOnly");
  });

  it("reports bothUnresolved when neither side has an answer", () => {
    expect(diffResolution(null, { kind: "unknown" })).toEqual("bothUnresolved");
  });
});

describe("tallyChainOutput", () => {
  it("counts every emitted edge, the file-only subset, and the declines", () => {
    const tally = tallyChainOutput([
      ...rows("match", 3, { chainOutput: "pinned" }),
      ...rows("fileOnly", 2, { chainOutput: "fileOnly" }),
      ...rows("missed", 4, { chainOutput: "none" }),
    ]);
    // fileOnly edges are a SUBSET of edges, not a sibling bucket — the -156
    // regression bd pmxuv measured was a drop in `edges`, invisible to every
    // verdict table because the checker had no opinion on those sites
    expect(tally).toEqual({ edges: 5, fileOnly: 2, unresolved: 4 });
  });

  it("counts nothing for an empty run", () => {
    expect(tallyChainOutput([])).toEqual({ edges: 0, fileOnly: 0, unresolved: 0 });
  });
});

describe("tallyBy", () => {
  it("counts every verdict bucket for a category", () => {
    const input = [
      ...rows("match", 6),
      ...rows("fileOnly", 2),
      ...rows("wrongFile", 1),
      ...rows("missed", 3),
      ...rows("phantom", 7),
      ...rows("agreeExternal", 13),
      ...rows("chainOnly", 4),
      ...rows("bothUnresolved", 5),
    ];

    const [tally] = tallyBy(input, (r) => r.categories);

    expect(tally).toEqual({
      label: "plain",
      sites: 41,
      oracle: 12,
      match: 6,
      fileOnly: 2,
      wrongFile: 1,
      missed: 3,
      external: 20,
      phantom: 7,
      agreeExternal: 13,
      chainOnly: 4,
      bothUnresolved: 5,
      mismatchRate: 4 / 12,
      phantomRate: 7 / 20,
    });
  });

  it("keeps the in-project denominator free of external, chainOnly and bothUnresolved rows", () => {
    const input = [
      ...rows("match", 1),
      ...rows("agreeExternal", 40),
      ...rows("chainOnly", 9),
      ...rows("bothUnresolved", 90),
    ];

    const [tally] = tallyBy(input, (r) => r.categories);

    expect(tally.oracle).toEqual(1);
    expect(tally.mismatchRate).toEqual(0);
  });

  it("rates phantom edges against the external ground truth rather than the in-project one", () => {
    const input = [...rows("match", 100), ...rows("phantom", 1), ...rows("agreeExternal", 3)];

    const [tally] = tallyBy(input, (r) => r.categories);

    expect(tally.external).toEqual(4);
    expect(tally.phantomRate).toEqual(0.25);
    expect(tally.mismatchRate).toEqual(0);
  });

  it("counts a multi-label row once under each of its categories", () => {
    const input = [row({ categories: ["generic", "unionNarrowing"], verdict: "missed" })];

    const tallies = tallyBy(input, (r) => r.categories);

    expect(tallies.map((t) => t.label).sort()).toEqual(["generic", "unionNarrowing"]);
    expect(tallies.every((t) => t.missed === 1 && t.mismatchRate === 1)).toEqual(true);
  });

  it("groups by receiver kind when handed the receiver-kind labeller", () => {
    const input = [
      row({ receiverKind: "bareCall", verdict: "match" }),
      row({ receiverKind: "chain", verdict: "missed" }),
      row({ receiverKind: "chain", verdict: "missed" }),
    ];

    const tallies = tallyBy(input, (r) => [r.receiverKind]);

    expect(tallies.map((t) => [t.label, t.sites])).toEqual([
      ["chain", 2],
      ["bareCall", 1],
    ]);
  });

  it("reports a zero mismatch rate when no call site in the category has a type-checker answer", () => {
    const input = rows("bothUnresolved", 7);

    const [tally] = tallyBy(input, (r) => r.categories);

    expect(tally.oracle).toEqual(0);
    expect(tally.mismatchRate).toEqual(0);
  });

  it("orders labels by call-site count descending so the widest category reads first", () => {
    const input = [
      ...rows("match", 1, { categories: ["overload"] }),
      ...rows("match", 5, { categories: ["generic"] }),
      ...rows("match", 3, { categories: ["jsx"] }),
    ];

    expect(tallyBy(input, (r) => r.categories).map((t) => t.label)).toEqual(["generic", "jsx", "overload"]);
  });
});

describe("flagTrackBPriorities", () => {
  it("flags a category whose mismatch rate clears the threshold on enough evidence", () => {
    const input = [
      ...rows("missed", 30, { categories: ["unionNarrowing"] }),
      ...rows("match", 10, { categories: ["unionNarrowing"] }),
    ];

    const flagged = flagTrackBPriorities(tallyBy(input, (r) => r.categories));

    expect(flagged.map((p) => p.label)).toEqual(["unionNarrowing"]);
    expect(flagged[0].mismatchRate).toEqual(0.75);
  });

  it("withholds a flag from a category with too few type-checker answers to trust", () => {
    const input = rows("missed", 3, { categories: ["structuralTyping"] });

    expect(flagTrackBPriorities(tallyBy(input, (r) => r.categories))).toEqual([]);
  });

  it("withholds a flag from a well-covered category the chain already agrees with", () => {
    const input = [
      ...rows("match", 99, { categories: ["generic"] }),
      ...rows("missed", 1, { categories: ["generic"] }),
    ];

    expect(flagTrackBPriorities(tallyBy(input, (r) => r.categories))).toEqual([]);
  });

  it("orders flagged categories by mismatch rate descending", () => {
    const input = [
      ...rows("missed", 10, { categories: ["a"] }),
      ...rows("match", 30, { categories: ["a"] }),
      ...rows("missed", 35, { categories: ["b"] }),
      ...rows("match", 5, { categories: ["b"] }),
    ];

    expect(flagTrackBPriorities(tallyBy(input, (r) => r.categories)).map((p) => p.label)).toEqual(["b", "a"]);
  });

  it("honours caller-supplied evidence and rate thresholds", () => {
    const input = [...rows("missed", 2, { categories: ["jsx"] }), ...rows("match", 2, { categories: ["jsx"] })];

    const flagged = flagTrackBPriorities(
      tallyBy(input, (r) => r.categories),
      { minOracle: 4, minMismatchRate: 0.5 },
    );

    expect(flagged.map((p) => p.label)).toEqual(["jsx"]);
  });
});

describe("findUncoveredCategories", () => {
  it("names the expected categories the corpus produced no call site for", () => {
    const tallies = tallyBy(rows("match", 2, { categories: ["generic"] }), (r) => r.categories);

    expect(findUncoveredCategories(tallies, ["generic", "jsx", "structuralTyping"])).toEqual([
      "jsx",
      "structuralTyping",
    ]);
  });

  it("returns nothing when every expected category has at least one call site", () => {
    const tallies = tallyBy(rows("match", 1, { categories: ["generic"] }), (r) => r.categories);

    expect(findUncoveredCategories(tallies, ["generic"])).toEqual([]);
  });
});

describe("formatOracleTable", () => {
  it("renders one row per label under the given title with the mismatch rate as a percentage", () => {
    const tallies = tallyBy(
      [...rows("missed", 1, { categories: ["generic"] }), ...rows("match", 3, { categories: ["generic"] })],
      (r) => r.categories,
    );

    const table = formatOracleTable("By type feature", tallies);

    expect(table).toContain("By type feature");
    expect(table).toContain("generic");
    expect(table).toContain("25.0%");
  });

  it("renders a placeholder row when there is nothing to tally", () => {
    expect(formatOracleTable("By type feature", [])).toContain("(no call sites)");
  });
});
