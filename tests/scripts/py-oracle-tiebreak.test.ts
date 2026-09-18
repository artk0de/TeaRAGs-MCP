/**
 * The third vote's rule table (bd tea-rags-mcp-1v12o.1.4, E5.0d).
 *
 * Pure surfaces only — no language server, no corpus. The rule is a table, so
 * it gets every cell: four disagreement verdicts × four tiebreak classes, plus
 * the self-reference pre-empt and the disagreement-set gate. The last block is
 * the identity gate in miniature: rows carrying the stage's four fields must
 * tally legacy and merged exactly as the same rows without them.
 */
import { describe, expect, it } from "vitest";

import {
  tallyPyRecall,
  tallyPyRows,
  type PyOracleRow,
  type PyOracleVerdict,
  type PyTiebreakClass,
} from "../../scripts/lib/py-oracle-core.js";
import {
  applyTiebreak,
  classifyTiebreak,
  isDisagreementRow,
  isOracleSelfReference,
  planTiebreakAsk,
  rescoreVerdict,
  tallyPyPrecision,
  tallyPyTiebroken,
  tiebreakRow,
  type PyrightReply,
} from "../../scripts/lib/py-oracle-tiebreak.js";

const row = (overrides: Partial<PyOracleRow> = {}): PyOracleRow => ({
  relPath: "customer/service.py",
  startLine: 399,
  callText: "repository.update(session)",
  receiver: "repository",
  member: "update",
  receiverKind: "chain",
  categories: [],
  verdict: "wrongFile",
  answeredBy: "chainType",
  chainOutput: "pinned",
  chain: { targetRelPath: "customer/repository.py", targetSymbolId: "CustomerRepository#update" },
  oracleTargetRelPath: "kit/repository/base.py",
  oracleTargetSymbolId: "RepositoryBase#update",
  oracleDegraded: false,
  oracleEngine: "jedi",
  ...overrides,
});

const pyright = (overrides: Partial<PyrightReply> = {}): PyrightReply => ({
  kind: "inProject",
  targetRelPath: "customer/repository.py",
  targetSymbolId: "CustomerRepository#update",
  ...overrides,
});

describe("isDisagreementRow", () => {
  it.each(["phantom", "wrongFile", "missed", "fileOnly"] as const)("asks pyright about %s", (verdict) => {
    expect(isDisagreementRow(row({ verdict }))).toBe(true);
  });

  it.each(["match", "agreeExternal", "bothUnresolved", "chainOnly"] as const)("never asks about %s", (verdict) => {
    expect(isDisagreementRow(row({ verdict }))).toBe(false);
  });

  /** No 1:1 verdict to arbitrate, and polar's damaged set is 7.6 % of its files. */
  it("skips a row already withheld from the rates", () => {
    expect(isDisagreementRow(row({ oracleDegraded: true }))).toBe(false);
    expect(isDisagreementRow(row({ verdict: "missed", dispatch: undefined, oracleDegraded: true }))).toBe(false);
  });
});

describe("classifyTiebreak", () => {
  it("backs the chain when pyright names the chain's own file and symbol", () => {
    expect(classifyTiebreak(row(), pyright())).toBe("agreesWithChain");
  });

  it("backs jedi when pyright names jedi's target", () => {
    const reply = pyright({ targetRelPath: "kit/repository/base.py", targetSymbolId: "RepositoryBase#update" });
    expect(classifyTiebreak(row(), reply)).toBe("agreesWithJedi");
  });

  it("is a third answer when pyright names some other in-project symbol", () => {
    const reply = pyright({ targetRelPath: "kit/other.py", targetSymbolId: "Other#update" });
    expect(classifyTiebreak(row(), reply)).toBe("third");
  });

  /** A `missed` row: the chain declined, and pyright says there was nothing in-project to find. */
  it("backs the chain's SILENCE when pyright answers external and the chain emitted nothing", () => {
    const missed = row({ verdict: "missed", chainOutput: "none", chain: undefined });
    expect(classifyTiebreak(missed, pyright({ kind: "external" }))).toBe("agreesWithChain");
  });

  /** A `phantom` row: jedi said external too, so an external third vote backs jedi. */
  it("backs jedi when pyright answers external and jedi named no in-project target", () => {
    const phantom = row({ verdict: "phantom", oracleTargetRelPath: null, oracleTargetSymbolId: null });
    expect(classifyTiebreak(phantom, pyright({ kind: "external" }))).toBe("agreesWithJedi");
  });

  it("is a third answer when pyright goes external and both engines named a target", () => {
    expect(classifyTiebreak(row(), pyright({ kind: "external" }))).toBe("third");
  });

  it.each(["unknown", "parseFailed", "missing"] as const)("books %s as noAnswer", (kind) => {
    expect(classifyTiebreak(row(), pyright({ kind }))).toBe("noAnswer");
  });

  /** `fileOnly` compares at FILE granularity against jedi; the chain's symbol still has to match. */
  it("backs the chain on a fileOnly row only when the SYMBOL agrees", () => {
    const fileOnly = row({ verdict: "fileOnly", oracleTargetSymbolId: null });
    expect(classifyTiebreak(fileOnly, pyright())).toBe("agreesWithChain");
    expect(classifyTiebreak(fileOnly, pyright({ targetSymbolId: "CustomerRepository#create" }))).toBe("third");
  });
});

describe("rescoreVerdict — the rule table, every cell", () => {
  const table: [PyOracleVerdict, PyTiebreakClass, string][] = [
    ["phantom", "agreesWithChain", "match"],
    ["wrongFile", "agreesWithChain", "match"],
    ["fileOnly", "agreesWithChain", "match"],
    ["missed", "agreesWithChain", "oracleWrongExternal"],
    ["phantom", "agreesWithJedi", "phantom"],
    ["wrongFile", "agreesWithJedi", "wrongFile"],
    ["fileOnly", "agreesWithJedi", "fileOnly"],
    ["missed", "agreesWithJedi", "missed"],
    ["phantom", "third", "undecidable"],
    ["wrongFile", "third", "undecidable"],
    ["fileOnly", "third", "undecidable"],
    ["missed", "third", "undecidable"],
    ["phantom", "noAnswer", "undecidable"],
    ["wrongFile", "noAnswer", "undecidable"],
    ["fileOnly", "noAnswer", "undecidable"],
    ["missed", "noAnswer", "undecidable"],
    ["phantom", "selfReference", "oracleSelfReference"],
    ["missed", "selfReference", "oracleSelfReference"],
    ["match", "notAsked", "match"],
    ["missed", "notAsked", "missed"],
    ["agreeExternal", "notAsked", "agreeExternal"],
  ];

  it.each(table)("%s × %s → %s", (verdict, tiebreak, expected) => {
    expect(rescoreVerdict(verdict, tiebreak)).toBe(expected);
  });
});

describe("oracleSelfReference", () => {
  const caller = "RepositoryBase.from_session";
  const clsRow = row({
    relPath: "kit/repository/base.py",
    startLine: 166,
    callText: "cls(session)",
    receiver: null,
    member: "cls",
    receiverKind: "bareCall",
    verdict: "missed",
    chainOutput: "none",
    chain: undefined,
    oracleTargetRelPath: "kit/repository/base.py",
    oracleTargetSymbolId: caller,
  });

  it("books jedi resolving the caller's own symbol", () => {
    expect(isOracleSelfReference(clsRow, caller)).toBe(true);
  });

  it("books pyright resolving it too — the shape is not one engine's mistake", () => {
    const other = row({ oracleTargetSymbolId: "RepositoryBase#update" });
    expect(isOracleSelfReference(other, caller, pyright({ targetSymbolId: caller }))).toBe(true);
  });

  it("leaves an ordinary disagreement alone", () => {
    expect(isOracleSelfReference(row(), caller, pyright())).toBe(false);
  });

  it("needs a caller symbol to compare against", () => {
    expect(isOracleSelfReference(clsRow, undefined)).toBe(false);
  });

  it("pre-empts the pyright classes entirely", () => {
    expect(tiebreakRow(clsRow, caller, pyright())).toMatchObject({
      tiebreak: "selfReference",
      verdictTiebroken: "oracleSelfReference",
    });
  });
});

describe("tiebreakRow", () => {
  it("keeps the verdict and records `notAsked` outside the disagreement set", () => {
    expect(tiebreakRow(row({ verdict: "match" }), "Caller#m", undefined)).toEqual({
      tiebreak: "notAsked",
      verdictTiebroken: "match",
      pyrightTargetRelPath: null,
      pyrightTargetSymbolId: null,
    });
  });

  it("carries pyright's own target onto the row", () => {
    expect(tiebreakRow(row(), "Caller#m", pyright())).toEqual({
      tiebreak: "agreesWithChain",
      verdictTiebroken: "match",
      pyrightTargetRelPath: "customer/repository.py",
      pyrightTargetSymbolId: "CustomerRepository#update",
    });
  });

  it("carries no target when pyright answered external", () => {
    expect(tiebreakRow(row(), "Caller#m", pyright({ kind: "external" })).pyrightTargetRelPath).toBeNull();
  });
});

describe("tallyPyTiebroken", () => {
  const rows = [
    row({ verdict: "match", verdictTiebroken: "match", tiebreak: "notAsked" }),
    row({ verdict: "wrongFile", verdictTiebroken: "match", tiebreak: "agreesWithChain" }),
    row({ verdict: "missed", verdictTiebroken: "oracleWrongExternal", tiebreak: "agreesWithChain" }),
    row({ verdict: "phantom", verdictTiebroken: "undecidable", tiebreak: "third" }),
    row({ verdict: "missed", verdictTiebroken: "oracleSelfReference", tiebreak: "selfReference" }),
    row({ verdict: "missed", verdictTiebroken: "missed", tiebreak: "agreesWithJedi" }),
  ];

  it("scores the re-scored verdict and counts what the stage withheld", () => {
    const [split] = tallyPyTiebroken(rows, () => ["(corpus)"]);
    expect(split).toMatchObject({ nTiebroken: 3, matchTiebroken: 2, withheldTiebroken: 3 });
    expect(split?.recallTiebroken).toBeCloseTo(2 / 3, 6);
  });

  /** Without the stage the third column has to read the same rows as the merged one. */
  it("reproduces the merged denominator when no row carries a tiebroken verdict", () => {
    const plain = rows.map(({ verdictTiebroken: _v, tiebreak: _t, ...rest }) => rest);
    const [tiebroken] = tallyPyTiebroken(plain, () => ["(corpus)"]);
    const [merged] = tallyPyRecall(plain, () => ["(corpus)"]);
    expect(tiebroken?.nTiebroken).toBe(merged?.nMerged);
    expect(tiebroken?.matchTiebroken).toBe(merged?.matchMerged);
  });
});

describe("tallyPyPrecision", () => {
  it("moves only the NUMERATOR — the chain emitted its edges whatever the third vote said", () => {
    const rows = [
      row({ verdict: "phantom", verdictTiebroken: "match", tiebreak: "agreesWithChain" }),
      row({ verdict: "wrongFile", verdictTiebroken: "undecidable", tiebreak: "third" }),
      row({ verdict: "match", verdictTiebroken: "match", tiebreak: "notAsked" }),
      row({ verdict: "missed", chainOutput: "none", chain: undefined, verdictTiebroken: "missed" }),
    ];
    const [split] = tallyPyPrecision(rows, () => ["(corpus)"]);
    expect(split).toMatchObject({ edgesMerged: 3, phantomMerged: 1, wrongFileMerged: 1 });
    expect(split).toMatchObject({ phantomTiebroken: 0, wrongFileTiebroken: 0 });
    expect(split?.precisionMissMerged).toBeCloseTo(2 / 3, 6);
    expect(split?.precisionMissTiebroken).toBe(0);
  });
});

describe("planTiebreakAsk", () => {
  const sites = [
    { relPath: "a.py", startLine: 10, callerSymbolId: "A#one" },
    { relPath: "a.py", startLine: 10, callerSymbolId: "A#one" },
    { relPath: "a.py", startLine: 44, callerSymbolId: "A#two" },
    { relPath: "b.py", startLine: 7, callerSymbolId: "B#one" },
    { relPath: "c.py", startLine: 3, callerSymbolId: "C#one" },
  ];
  const rows = [
    row({ verdict: "match" }),
    row({ verdict: "wrongFile" }),
    row({ verdict: "match" }),
    row({ verdict: "match" }),
    row(),
  ];
  const wanted = (_entry: PyOracleRow, index: number): boolean => index === 1 || index === 4;

  /**
   * The LINE cohort, not the whole file: `askOracle` claims successive
   * occurrences of a callee within one `startLine` as it walks a file's batch,
   * so dropping a site on the SAME line would re-pin the next one to the wrong
   * column — while a site on another line cannot reach it at all.
   */
  it("sends every site sharing a line with an arbitrated one, and nothing else", () => {
    const plan = planTiebreakAsk(rows, sites, wanted);
    expect(plan.arbitrated).toEqual([1, 4]);
    expect(plan.sent).toEqual([0, 1, 4]);
    expect(plan.files).toEqual(["a.py", "c.py"]);
  });

  it("numbers each file's answers from zero over the sites it SENT, in walk order", () => {
    const plan = planTiebreakAsk(rows, sites, wanted);
    expect([...plan.answerIndex]).toEqual([
      [0, 0],
      [1, 1],
      [4, 0],
    ]);
  });

  it("asks nobody when no row disagrees", () => {
    const plan = planTiebreakAsk(rows, sites, () => false);
    expect(plan).toMatchObject({ arbitrated: [], sent: [], files: [] });
  });
});

describe("applyTiebreak", () => {
  const sites = [
    { relPath: "a.py", startLine: 399, callerSymbolId: "A#one" },
    { relPath: "a.py", startLine: 166, callerSymbolId: "A.from_session" },
  ];
  const rows = [
    row({ relPath: "a.py", verdict: "wrongFile" }),
    row({
      relPath: "a.py",
      verdict: "missed",
      chainOutput: "none",
      chain: undefined,
      oracleTargetRelPath: "a.py",
      oracleTargetSymbolId: "A.from_session",
    }),
  ];
  const reply = {
    relPath: "a.py",
    parseFailed: false,
    parsoErrors: 0,
    answers: [
      {
        startLine: 399,
        member: "update",
        outcome: {
          kind: "inProject" as const,
          targets: [{ relPath: "customer/repository.py", symbolId: "CustomerRepository#update", pinUncertain: false }],
        },
      },
    ],
  };

  it("re-scores the arbitrated row and leaves the self-reference row unasked", () => {
    const plan = planTiebreakAsk(rows, sites, (entry, index) => index === 0 && isDisagreementRow(entry));
    const { rows: scored, counts } = applyTiebreak(rows, sites, plan, new Map([["a.py", reply]]));
    expect(scored[0]).toMatchObject({
      tiebreak: "agreesWithChain",
      verdictTiebroken: "match",
      pyrightTargetSymbolId: "CustomerRepository#update",
    });
    expect(scored[1]).toMatchObject({ tiebreak: "selfReference", verdictTiebroken: "oracleSelfReference" });
    // Only the arbitrated site is sent: the self-reference row sits on its own
    // line, so it is not in the cohort and costs pyright nothing.
    expect(counts).toMatchObject({ agreesWithChain: 1, selfReference: 1, sitesAsked: 1, filesAsked: 1 });
    expect(counts.selfReferenceByVerdict).toEqual({ missed: 1 });
  });

  /** A file pyright never answered is `noAnswer`, not an external reading. */
  it("books a missing reply as noAnswer", () => {
    const plan = planTiebreakAsk(rows, sites, (entry, index) => index === 0 && isDisagreementRow(entry));
    const { rows: scored, counts } = applyTiebreak(rows, sites, plan, new Map());
    expect(scored[0]).toMatchObject({ tiebreak: "noAnswer", verdictTiebroken: "undecidable" });
    expect(counts.noAnswer).toBe(1);
  });

  /**
   * RECURSION. `foo()` inside `foo` resolves to the caller's own symbol and both
   * engines are RIGHT — the shape is only debt where the two disagree, which is
   * why the pre-empt is scoped to the disagreement set (measured on ugnest,
   * where 4 `match` rows were withheld before the scope was added).
   */
  it("never withholds a recursive call the two engines agree on", () => {
    const recursive = [
      row({
        relPath: "a.py",
        verdict: "match",
        oracleTargetRelPath: "a.py",
        oracleTargetSymbolId: "A#one",
        chain: { targetRelPath: "a.py", targetSymbolId: "A#one" },
      }),
    ];
    const plan = planTiebreakAsk(recursive, [sites[0] ?? { relPath: "a.py", startLine: 399 }], () => false);
    const { rows: scored, counts } = applyTiebreak(recursive, sites, plan, new Map());
    expect(scored[0]).toMatchObject({ tiebreak: "notAsked", verdictTiebroken: "match" });
    expect(counts.selfReference).toBe(0);
  });

  it("gives every row a tiebroken verdict, asked or not", () => {
    const plan = planTiebreakAsk(rows, sites, () => false);
    const { rows: scored } = applyTiebreak(rows, sites, plan, new Map());
    expect(scored.map((entry) => entry.verdictTiebroken)).toEqual(["wrongFile", "oracleSelfReference"]);
  });
});

describe("the identity gate, in miniature", () => {
  const base = [
    row({ verdict: "wrongFile" }),
    row({ verdict: "match" }),
    row({ verdict: "missed", chainOutput: "none", chain: undefined }),
    row({ verdict: "phantom" }),
  ];
  const staged = base.map(
    (entry, index): PyOracleRow => ({
      ...entry,
      tiebreak: index === 0 ? "agreesWithChain" : "notAsked",
      verdictTiebroken: index === 0 ? "match" : entry.verdict,
      pyrightTargetRelPath: "customer/repository.py",
      pyrightTargetSymbolId: "CustomerRepository#update",
    }),
  );

  it("leaves the legacy and merged tallies byte-identical with the stage's fields present", () => {
    expect(tallyPyRows(staged, (entry) => [entry.receiverKind])).toEqual(
      tallyPyRows(base, (entry) => [entry.receiverKind]),
    );
    expect(tallyPyRecall(staged, (entry) => [entry.receiverKind])).toEqual(
      tallyPyRecall(base, (entry) => [entry.receiverKind]),
    );
  });

  /** `phantom` sits outside the recall denominator, so three rows are scored, not four. */
  it("still moves the tiebroken column", () => {
    const [split] = tallyPyTiebroken(staged, () => ["(corpus)"]);
    expect(split).toMatchObject({ nTiebroken: 3, matchTiebroken: 2 });
  });
});
