import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import type {
  ResidualCallSiteRow,
  StaticSiteSampleRow,
} from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import { GroupTournament } from "../../../../../../src/core/domains/trajectory/codegraph/residual/receiver-group-tournament.js";
import { buildCalibrationStrata } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-calibration-strata.js";
import {
  calibrationAccuracy,
  ResidualCalibration,
  type ResidualCalibrationInput,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-calibration.js";
import {
  residualQuestionFold,
  residualQuestionHash,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestion,
  ResidualQuestionGroup,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/types.js";

type Answer = (q: ResidualQuestion) => { pick: string | null; p: number };

class FakeProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold = 0.7;
  readonly calls: ResidualQuestionGroup[] = [];
  healthy = true;

  constructor(private readonly answer: Answer) {}

  version = async () => "fake@1";
  health = async () => (this.healthy ? { ok: true as const } : { ok: false as const, reason: "down" });

  resolveGroup = async (group: ResidualQuestionGroup): Promise<ResidualAnswer[]> => {
    this.calls.push(group);
    return group.questions.map((q) => {
      const { pick, p } = this.answer(q);
      return { siteKey: q.siteKey, pick, p, probabilities: { [pick ?? "(none)"]: p }, questionPayload: "{}" };
    });
  };

  questions(): ResidualQuestion[] {
    return this.calls.flatMap((c) => c.questions);
  }
}

let seq = 0;

function sample(over: Partial<StaticSiteSampleRow> = {}): StaticSiteSampleRow {
  seq++;
  return {
    siteKey: `site-${seq}`,
    sourceRelPath: "app/a.rb",
    language: "ruby",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 20,
    line: 5,
    column: 4,
    receiverText: "invoice",
    receiverKind: "localVar",
    member: "total",
    outcome: "resolved",
    targetSymbolId: "Invoice#total",
    reason: null,
    owners: 2,
    candidates: ["Estimate#total", "Invoice#total"],
    menuOverflow: false,
    priority: seq / 10_000,
    ...over,
  };
}

describe("ResidualCalibration", () => {
  let rootDir: string;
  let store: ResidualVerdictStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-calibration-"));
    store = await ResidualVerdictStore.open(rootDir, "code_test");
  });

  afterEach(async () => {
    await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  function input(rows: StaticSiteSampleRow[], provider: FakeProvider): ResidualCalibrationInput {
    return {
      graphDb: { readStaticSiteSample: async () => rows },
      store,
      provider,
      concurrency: 2,
      menuLimit: 40,
      readMethodSource: async () => "def run\n  invoice.total\nend",
      now: () => 1_000,
    };
  }

  it("asks each stratum's question and scores the top answer against the truth", async () => {
    const rows = [
      sample(),
      sample({ outcome: "externalSkipped", targetSymbolId: null, reason: "externalSkipped" }),
      sample({ receiverText: "thing" }),
    ];
    const provider = new FakeProvider((q) =>
      q.siteKey.startsWith("cal:external:") ? { pick: "Invoice", p: 0.6 } : { pick: "Invoice", p: 0.9 },
    );

    const report = await new ResidualCalibration().run(input(rows, provider));

    expect(report.outcome).toBe("completed");
    expect(report.strata).toEqual({ fullMenu: 2, block1: 1, external: 1 });
    expect(report.records).toHaveLength(4);
    expect(report.records).toContainEqual({ stratum: "external", p: 0.6, top: "class", correct: false, menuSize: 2 });
    expect(report.records.filter((r) => r.stratum === "fullMenu")).toEqual([
      { stratum: "fullMenu", p: 0.9, top: "class", correct: true, menuSize: 2 },
      { stratum: "fullMenu", p: 0.9, top: "class", correct: true, menuSize: 2 },
    ]);
  });

  it("a none answer on an external site is correct; on a resolved one it is not", async () => {
    const rows = [sample(), sample({ outcome: "externalSkipped", targetSymbolId: null })];
    const provider = new FakeProvider(() => ({ pick: null, p: 0.8 }));

    const report = await new ResidualCalibration().run(input(rows, provider));

    expect(report.records.find((r) => r.stratum === "external")).toMatchObject({ top: "none", correct: true });
    expect(report.records.find((r) => r.stratum === "fullMenu")).toMatchObject({ top: "none", correct: false });
  });

  it("asks the question the pass asks a receiver group over the same classes", async () => {
    const row = sample();
    const provider = new FakeProvider(() => ({ pick: "Invoice", p: 0.9 }));

    await new ResidualCalibration().run(input([row], provider));

    const [item] = buildCalibrationStrata([row], { menuLimit: 40 }).filter((i) => i.stratum === "fullMenu");
    const fold = residualQuestionFold({ originContext: false });
    const group = {
      id: item.key,
      sourceRelPath: row.sourceRelPath,
      methodSymbolId: row.methodSymbolId,
      methodStartLine: row.methodStartLine,
      methodEndLine: row.methodEndLine,
      receiverText: row.receiverText,
      kind: "ambiguous" as const,
      members: [row.member],
      lines: [row.line],
      classes: item.classes,
      rows: [] as ResidualCallSiteRow[],
    };
    const [passQuestion] = new GroupTournament(group, 40, (h) => residualQuestionHash(h, fold)).questions();
    const asked = provider.questions().find((q) => q.siteKey === item.key);

    expect(asked).toEqual(passQuestion);
    expect(provider.calls[0]).toMatchObject({ sourceRelPath: "app/a.rb", methodSymbolId: "A#run" });
  });

  it("stores verdicts under the calibration keys and reuses them on the next run", async () => {
    const rows = [sample()];
    const provider = new FakeProvider(() => ({ pick: "Invoice", p: 0.9 }));
    await new ResidualCalibration().run(input(rows, provider));
    const asked = provider.questions().length;

    const again = await new ResidualCalibration().run(input(rows, provider));

    expect(provider.questions()).toHaveLength(asked);
    expect(again.cacheHits).toBe(asked);
    expect(again.records).toHaveLength(asked);
    const keys = provider.questions().map((q) => q.siteKey);
    expect(keys.every((k) => k.startsWith("cal:"))).toBe(true);
    expect(await store.findLatest([{ siteKey: rows[0].siteKey, menuHash: "x" }], "kev")).toEqual([]);
  });

  it("an unavailable provider skips the asking and scores only cached verdicts", async () => {
    const provider = new FakeProvider(() => ({ pick: "Invoice", p: 0.9 }));
    provider.healthy = false;

    const report = await new ResidualCalibration().run(input([sample()], provider));

    expect(report.outcome).toBe("skipped");
    expect(report.reason).toContain("unavailable");
    expect(provider.calls).toEqual([]);
    expect(report.records).toEqual([]);
  });
});

describe("calibrationAccuracy", () => {
  it("counts each stratum and its accuracy at each cut", () => {
    const summary = calibrationAccuracy(
      [
        { stratum: "fullMenu", p: 0.9, top: "class", correct: true, menuSize: 2 },
        { stratum: "fullMenu", p: 0.6, top: "class", correct: false, menuSize: 2 },
        { stratum: "fullMenu", p: 0.3, top: "none", correct: false, menuSize: 2 },
      ],
      [0.5, 0.7],
    );

    expect(summary.fullMenu).toEqual({
      answered: 3,
      cuts: [
        { p: 0.5, n: 2, correct: 1, accuracy: 0.5 },
        { p: 0.7, n: 1, correct: 1, accuracy: 1 },
      ],
    });
    expect(summary.block1).toEqual({
      answered: 0,
      cuts: [
        { p: 0.5, n: 0, correct: 0, accuracy: null },
        { p: 0.7, n: 0, correct: 0, accuracy: null },
      ],
    });
  });
});
