import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BASELINE,
  evaluateSites,
  gateFailures,
  scoreOutcomes,
  siteGroup,
  type EvalOutcome,
  type EvalSite,
} from "../../scripts/residual-eval.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestionGroup,
} from "../../src/core/contracts/types/codegraph-residual.js";

const FIXTURES = join(import.meta.dirname, "../fixtures/residual-eval");

const site = (over: Partial<EvalSite>): EvalSite => ({
  file: "app/a.rb",
  line: 3,
  method: "run",
  param: "firm",
  member: "users",
  truth: "Firm",
  candidates: ["Firm", "Client"],
  all_candidates: 2,
  naming_hit: true,
  source: "def run(firm)\n  firm.users\nend",
  ...over,
});

const outcome = (over: Partial<EvalSite>, pick: string, p: number): EvalOutcome => ({
  site: site(over),
  pick,
  p,
});

const readSites = (): EvalSite[] =>
  readFileSync(join(FIXTURES, "sites40.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalSite);

describe("scoreOutcomes", () => {
  const outcomes = [
    outcome({ naming_hit: true }, "Firm", 0.95),
    outcome({ naming_hit: true }, "Client", 0.6),
    outcome({ naming_hit: false, truth: "Client" }, "Client", 0.8),
    outcome({ naming_hit: false, truth: "Client" }, "Firm", 0.4),
  ];

  it("splits accuracy by whether the parameter name named the class", () => {
    const score = scoreOutcomes(outcomes);

    expect(score.total).toBe(4);
    expect(score.accuracy).toEqual({ all: 0.5, namingMiss: 0.5, namingHit: 0.5 });
  });

  it("reports coverage and precision of the answers at or above each threshold", () => {
    const score = scoreOutcomes(outcomes, [0.5, 0.7, 0.9]);

    expect(score.atThreshold).toEqual([
      { threshold: 0.5, coverage: 0.75, precision: 2 / 3 },
      { threshold: 0.7, coverage: 0.5, precision: 1 },
      { threshold: 0.9, coverage: 0.25, precision: 1 },
    ]);
  });

  it("gives precision 0 when no answer clears the threshold", () => {
    expect(scoreOutcomes([outcome({}, "Firm", 0.1)], [0.9]).atThreshold).toEqual([
      { threshold: 0.9, coverage: 0, precision: 0 },
    ]);
  });
});

describe("gateFailures", () => {
  const at = {
    total: 1,
    accuracy: { all: BASELINE.all, namingMiss: BASELINE.namingMiss, namingHit: 1 },
    atThreshold: [],
  };

  it("passes at the bar", () => {
    expect(gateFailures(at)).toEqual([]);
  });

  it("names each missed bar", () => {
    const below = { ...at, accuracy: { all: 0.9, namingMiss: 0.7, namingHit: 1 } };

    expect(gateFailures(below)).toEqual(["accuracy 0.900 < bar 0.93", "naming-miss accuracy 0.700 < bar 0.8"]);
  });
});

describe("siteGroup", () => {
  it("asks one question per site with method-symbol candidates", () => {
    const group = siteGroup(site({}), 7);

    expect(group).toEqual({
      sourceRelPath: "app/a.rb",
      methodSymbolId: "run",
      methodSource: "def run(firm)\n  firm.users\nend",
      questions: [
        {
          siteKey: "site-7",
          menuHash: "eval-7",
          receiverText: "firm",
          member: "users",
          kind: "ambiguous",
          candidates: ["Firm#users", "Client#users"],
        },
      ],
    });
  });
});

describe("evaluateSites", () => {
  const fakeProvider = (pickOf: (group: ResidualQuestionGroup) => string): ResidualModelProvider => ({
    id: "fake",
    threshold: 0.7,
    version: async () => "fake-run",
    health: async () => ({ ok: true }),
    resolveGroup: async (group): Promise<ResidualAnswer[]> =>
      group.questions.map((question) => ({
        siteKey: question.siteKey,
        pick: pickOf(group),
        p: 0.8,
        probabilities: {},
        questionPayload: "{}",
      })),
  });

  it("maps each answer back to its site as a class, in site order, at any concurrency", async () => {
    const sites = [site({ truth: "Firm" }), site({ truth: "Client", line: 9 }), site({ truth: "Firm", line: 11 })];
    const provider = fakeProvider((group) => (group.questions[0].siteKey === "site-1" ? "Client#users" : "Firm#users"));

    const outcomes = await evaluateSites(provider, sites, 2);

    expect(outcomes.map((o) => [o.site.line, o.pick, o.p])).toEqual([
      [3, "Firm", 0.8],
      [9, "Client", 0.8],
      [11, "Firm", 0.8],
    ]);
    expect(scoreOutcomes(outcomes).accuracy.all).toBe(1);
  });
});

describe("fixtures", () => {
  it("sites40 holds 91 sites, each with its truth on the menu", () => {
    const rows = readSites();

    expect(rows).toHaveLength(91);
    for (const row of rows) expect(row.candidates).toContain(row.truth);
  });

  it("the recorded Kev baseline answers every site and clears the gate", () => {
    const sites = readSites();
    const baseline = JSON.parse(readFileSync(join(FIXTURES, "baseline-kev.json"), "utf8")) as {
      file: string;
      param: string;
      member: string;
      pick: string;
      p: number;
    }[];
    const outcomes = baseline.map((row, index) => ({
      site: sites[index],
      pick: row.pick,
      p: row.p,
    }));

    expect(baseline).toHaveLength(sites.length);
    expect(
      baseline.every(
        (row, i) => row.file === sites[i].file && row.param === sites[i].param && row.member === sites[i].member,
      ),
    ).toBe(true);
    expect(gateFailures(scoreOutcomes(outcomes))).toEqual([]);
  });
});
