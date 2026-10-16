import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import { KevStateTooLongError } from "../../../../../../src/core/adapters/kev/errors.js";
import type {
  ModelEdgeRow,
  ModelExternalSiteRow,
  ResidualCallSiteRow,
} from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import {
  ResidualResolutionPass,
  type ResidualPassInput,
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
  /** Longest method source, in lines, the fake accepts before refusing it as too long. */
  maxSourceLines = Number.POSITIVE_INFINITY;

  constructor(private readonly answer: Answer) {}

  version = async () => "fake@1";
  health = async (): Promise<{ ok: true }> => ({ ok: true });

  resolveGroup = async (group: ResidualQuestionGroup): Promise<ResidualAnswer[]> => {
    this.calls.push(group);
    if (group.methodSource.split("\n").length > this.maxSourceLines) {
      throw new KevStateTooLongError("http://gpu:1", "too long");
    }
    return group.questions.map((q) => {
      const { pick, p } = this.answer(q);
      return { siteKey: q.siteKey, pick, p, probabilities: { [pick ?? "(none)"]: p }, questionPayload: "{}" };
    });
  };

  questions(): ResidualQuestion[] {
    return this.calls.flatMap((c) => c.questions);
  }
}

function fakeGraphDb(rows: ResidualCallSiteRow[]) {
  const applied: ModelEdgeRow[][] = [];
  const external: ModelExternalSiteRow[][] = [];
  return {
    applied,
    external,
    readResidualCallSites: async () => rows,
    applyModelEdges: async (_model: string, edges: ModelEdgeRow[]) => {
      applied.push(edges);
      return { stored: edges.length, changed: true };
    },
    applyModelExternalSites: async (_model: string, sites: ModelExternalSiteRow[]) => {
      external.push(sites);
    },
    markDerivedStale: async () => undefined,
  };
}

const CLASSES3: [string, string][] = [
  ["Invoice", "Invoice#M"],
  ["Bill", "Document#M"],
  ["Estimate", "Estimate#M"],
];

/** A site on `record` in `A#run`, its class targets naming `member`. */
function groupedRow(siteKey: string, member: string, line: number, classes = CLASSES3): ResidualCallSiteRow {
  const classTargets = classes.map(([c, target]) => [c, target.replace("#M", `#${member}`)] as [string, string]);
  return {
    siteKey,
    sourceRelPath: "app/a.rb",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 200,
    line,
    column: 4,
    receiverText: "record",
    member,
    kind: "dynamic",
    candidates: classTargets.slice(0, 40).map(([, t]) => t),
    menuHash: `menu-${siteKey}`,
    menuOverflow: classTargets.length > 40,
    receiverGroup: "group-record",
    classTargets,
  };
}

const manyClasses = (n: number): [string, string][] =>
  Array.from({ length: n }, (_, i) => [`K${String(i).padStart(3, "0")}`, `K${String(i).padStart(3, "0")}#M`]);

describe("ResidualResolutionPass — receiver groups", () => {
  let rootDir: string;
  let store: ResidualVerdictStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-group-pass-"));
    store = await ResidualVerdictStore.open(rootDir, "code_test");
  });

  afterEach(async () => {
    await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  const run = async (
    graphDb: ReturnType<typeof fakeGraphDb>,
    provider: FakeProvider,
    over: Partial<Omit<ResidualPassInput, "graphDb" | "store" | "provider">> = {},
  ) =>
    new ResidualResolutionPass().run({
      graphDb,
      store,
      provider,
      mode: "ask",
      concurrency: 2,
      menuLimit: 40,
      minMenu: 1,
      noneThreshold: 0.8,
      retentionDays: 180,
      recomputeDerived: async () => undefined,
      readMethodSource: async (_relPath, startLine, endLine) =>
        Array.from({ length: endLine - startLine + 1 }, (_, i) => `L${startLine + i}`).join("\n"),
      now: () => 1_000,
      ...over,
    });

  it("asks one class question per receiver group and edges every site of the group with its p", async () => {
    const graphDb = fakeGraphDb([
      groupedRow("s1", "save", 2),
      groupedRow("s2", "name", 3),
      groupedRow("s3", "touch", 4),
    ]);
    const provider = new FakeProvider(() => ({ pick: "Bill", p: 0.92 }));

    const report = await run(graphDb, provider);

    const questions = provider.questions();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      subject: "class",
      receiverText: "record",
      candidates: ["Invoice", "Bill", "Estimate"],
      members: ["name", "save", "touch"],
    });
    expect(graphDb.applied.at(-1)).toEqual([
      {
        siteKey: "s1",
        sourceRelPath: "app/a.rb",
        sourceSymbolId: "A#run",
        targetSymbolId: "Document#save",
        model: "kev",
        p: 0.92,
      },
      {
        siteKey: "s2",
        sourceRelPath: "app/a.rb",
        sourceSymbolId: "A#run",
        targetSymbolId: "Document#name",
        model: "kev",
        p: 0.92,
      },
      {
        siteKey: "s3",
        sourceRelPath: "app/a.rb",
        sourceSymbolId: "A#run",
        targetSymbolId: "Document#touch",
        model: "kev",
        p: 0.92,
      },
    ]);
    expect(report).toMatchObject({
      receiverGroups: 1,
      receiverGroupSites: 3,
      asked: 1,
      sitesEdged: 3,
      sitesEdgedByVerdict: 3,
      sitesEdgedByPropagation: 0,
      tournamentGroups: 0,
    });
  });

  it("moves every site of the group to externalByModel on a confident none", async () => {
    const graphDb = fakeGraphDb([groupedRow("s1", "save", 2), groupedRow("s2", "name", 3)]);
    const provider = new FakeProvider(() => ({ pick: null, p: 0.85 }));

    const report = await run(graphDb, provider);

    expect(graphDb.external.at(-1)?.map((s) => s.siteKey)).toEqual(["s1", "s2"]);
    expect(graphDb.applied.at(-1)).toEqual([]);
    expect(report.externalByModel).toBe(2);
  });

  it("runs a tournament over a class set beyond the menu limit and caches every round", async () => {
    const classes = manyClasses(120);
    const rows = [groupedRow("s1", "save", 2, classes), groupedRow("s2", "name", 3, classes)];
    // Each block's winner is its first class; the final round picks the last entrant.
    const answer: Answer = (q) =>
      q.candidates.length === 3 ? { pick: q.candidates[2], p: 0.9 } : { pick: q.candidates[0], p: 0.6 };
    const provider = new FakeProvider(answer);

    const report = await run(fakeGraphDb(rows), provider);

    const questions = provider.questions();
    expect(questions.map((q) => q.candidates.length)).toEqual([40, 40, 40, 3]);
    expect(questions[3].candidates).toEqual(["K000", "K040", "K080"]);
    expect(report).toMatchObject({ tournamentGroups: 1, tournamentRounds: 2, tournamentQuestions: 4, sitesEdged: 2 });

    const graphDb = fakeGraphDb(rows);
    const rerunProvider = new FakeProvider(answer);
    const rerun = await run(graphDb, rerunProvider);

    expect(rerunProvider.calls).toHaveLength(0);
    expect(rerun.asked).toBe(0);
    expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["K080#save", "K080#name"]);
  });

  it("leaves the group residual when no block winner clears the floor", async () => {
    const rows = [groupedRow("s1", "save", 2, manyClasses(120))];
    const provider = new FakeProvider((q) => ({ pick: q.candidates[0], p: 0.3 }));

    const report = await run(fakeGraphDb(rows), provider, { tournamentFloor: 0.5 });

    expect(provider.questions()).toHaveLength(3);
    expect(report.sitesEdged).toBe(0);
  });

  it("skips and counts tournament groups the question budget cannot cover", async () => {
    const rows = [
      groupedRow("s1", "save", 2, manyClasses(120)),
      { ...groupedRow("s2", "save", 5), receiverGroup: "group-other", receiverText: "other" },
    ];
    const provider = new FakeProvider((q) => ({ pick: q.candidates[0], p: 0.9 }));

    const report = await run(fakeGraphDb(rows), provider, { tournamentBudget: 2 });

    expect(provider.questions().map((q) => q.receiverText)).toEqual(["other"]);
    expect(report.groupsSkippedByBudget).toBe(1);
    expect(report.sitesEdged).toBe(1);
  });

  it("asks a method refused as too long again over a window around the group's call lines", async () => {
    const graphDb = fakeGraphDb([groupedRow("s1", "save", 150), groupedRow("s2", "name", 152)]);
    const provider = new FakeProvider(() => ({ pick: "Invoice", p: 0.9 }));
    provider.maxSourceLines = 60;

    const report = await run(graphDb, provider);

    expect(provider.calls).toHaveLength(2);
    const windowed = provider.calls[1].methodSource.split("\n");
    expect(windowed[0]).toBe("L1");
    expect(windowed).toContain("L150");
    expect(windowed).toContain("L152");
    expect(windowed.length).toBeLessThanOrEqual(60);
    expect(report).toMatchObject({ tooLong: 0, windowedGroups: 1, sitesEdged: 2 });
  });
});
