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

/** A site on `receiverText` in `A#run` whose class targets carry the target's return type. */
function hopRow(
  siteKey: string,
  receiverText: string,
  member: string,
  classes: [string, string | null, string?][],
  downstreamGroup?: string,
): ResidualCallSiteRow {
  return {
    siteKey,
    sourceRelPath: "app/a.rb",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 20,
    line: 5,
    column: 4,
    receiverText,
    member,
    kind: "dynamic",
    candidates: classes.flatMap(([, t]) => (t === null ? [] : [t])),
    menuHash: `menu-${siteKey}`,
    menuOverflow: false,
    receiverGroup: `group-${receiverText}`,
    classTargets: classes,
    ...(downstreamGroup === undefined ? {} : { downstreamGroup }),
  };
}

/** Answers each receiver's class question from `byReceiver`; any other receiver gets a low-p first class. */
const answerByReceiver =
  (byReceiver: Record<string, { pick: string | null; p: number }>): Answer =>
  (q) =>
    byReceiver[q.receiverText] ?? { pick: q.candidates[0] ?? null, p: 0.3 };

const edgeOf = (edges: ModelEdgeRow[] | undefined, siteKey: string) => edges?.find((e) => e.siteKey === siteKey);

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

  describe("the receiver's name opens the tournament", () => {
    /** `invoice` over 120 unrelated classes with `Invoice` in the middle. */
    const named = (siteKey = "s1", line = 2): ResidualCallSiteRow => {
      const classes = manyClasses(120);
      classes.splice(60, 0, ["Invoice", "Invoice#M"]);
      return { ...groupedRow(siteKey, "save", line, classes), receiverText: "invoice", receiverGroup: "group-invoice" };
    };
    const unnamed = (): ResidualCallSiteRow => groupedRow("u1", "save", 7, manyClasses(120));

    it("asks the name-matched classes alone first and ends the tournament on a confident winner", async () => {
      const graphDb = fakeGraphDb([named()]);
      const provider = new FakeProvider((q) => ({ pick: q.candidates[0], p: 0.9 }));

      const report = await run(graphDb, provider);

      expect(provider.questions().map((q) => q.candidates)).toEqual([["Invoice"]]);
      expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["Invoice#save"]);
      expect(report).toMatchObject({
        namePriorGroups: 1,
        earlyAcceptedGroups: 1,
        tournamentQuestions: 1,
        tournamentRounds: 1,
      });
    });

    it("runs the remaining classes when block 1 is not confident, its winner joining their winners", async () => {
      const answer: Answer = (q) =>
        q.candidates.length === 4 ? { pick: q.candidates[0], p: 0.9 } : { pick: q.candidates[0], p: 0.6 };
      const graphDb = fakeGraphDb([named()]);
      const provider = new FakeProvider(answer);

      const report = await run(graphDb, provider);

      const questions = provider.questions();
      expect(questions.map((q) => q.candidates.length)).toEqual([1, 40, 40, 40, 4]);
      expect(questions[4].candidates).toEqual(["Invoice", "K000", "K040", "K080"]);
      expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["Invoice#save"]);
      expect(report).toMatchObject({
        earlyAcceptedGroups: 0,
        tournamentQuestions: 5,
        tournamentRounds: 3,
        confirmQuestions: 0,
        confirmAccepted: 0,
      });
    });

    it("never drops a class the name leaves out: a confident none in block 1 hands the group to the rest", async () => {
      const answer: Answer = (q) =>
        q.candidates.length === 1 ? { pick: null, p: 0.95 } : { pick: q.candidates.at(-1) ?? null, p: 0.9 };
      const graphDb = fakeGraphDb([named()]);
      const provider = new FakeProvider(answer);

      const report = await run(graphDb, provider);

      expect(provider.questions().map((q) => q.candidates.length)).toEqual([1, 40, 40, 40, 3]);
      expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["K119#save"]);
      expect(report.externalByModel).toBe(0);
    });

    it("spends the budget on name-matched groups before the others", async () => {
      const graphDb = fakeGraphDb([unnamed(), named()]);
      const provider = new FakeProvider((q) => ({ pick: q.candidates[0], p: 0.9 }));

      const report = await run(graphDb, provider, { tournamentBudget: 1 });

      expect(provider.questions().map((q) => q.receiverText)).toEqual(["invoice"]);
      expect(report).toMatchObject({ earlyAcceptedGroups: 1, groupsSkippedByBudget: 1, tournamentQuestions: 1 });
    });

    it("holds the other tournaments back while the budget could not cover the name-matched ones", async () => {
      // Block 1 accepts at once; the other tournament needs 3 + 1 questions of a budget of 5.
      const answer: Answer = (q) =>
        q.candidates.length === 1 ? { pick: q.candidates[0], p: 0.9 } : { pick: q.candidates[0], p: 0.6 };
      const provider = new FakeProvider(answer);

      const report = await run(fakeGraphDb([unnamed(), named()]), provider, { tournamentBudget: 5 });

      const receivers = provider.questions().map((q) => q.receiverText);
      expect(receivers.lastIndexOf("invoice")).toBeLessThan(receivers.indexOf("record"));
      expect(receivers.filter((r) => r === "record")).toHaveLength(4);
      expect(report.groupsSkippedByBudget).toBe(0);
    });

    it("starts the other tournaments alongside the name-matched ones when the budget covers both", async () => {
      const answer: Answer = (q) =>
        q.candidates.length === 4 ? { pick: q.candidates[0], p: 0.9 } : { pick: q.candidates[0], p: 0.6 };
      const provider = new FakeProvider(answer);

      await run(fakeGraphDb([unnamed(), named()]), provider);

      const receivers = provider.questions().map((q) => q.receiverText);
      expect(new Set(provider.calls[0].questions.map((q) => q.receiverText))).toEqual(new Set(["invoice", "record"]));
      expect(receivers.filter((r) => r === "record")).toHaveLength(4);
      expect(receivers.filter((r) => r === "invoice")).toHaveLength(5);
    });

    it("leaves a group within the menu limit to its single question", async () => {
      const row = { ...groupedRow("s1", "save", 2), receiverText: "invoice" };
      const provider = new FakeProvider((q) => ({ pick: q.candidates[0], p: 0.9 }));

      const report = await run(fakeGraphDb([row]), provider);

      expect(provider.questions().map((q) => q.candidates)).toEqual([["Invoice", "Bill", "Estimate"]]);
      expect(report).toMatchObject({ namePriorGroups: 0, earlyAcceptedGroups: 0 });
    });
  });

  describe("the confirm stage re-asks a mid pick as [pick, none]", () => {
    const named = (): ResidualCallSiteRow => {
      const classes = manyClasses(120);
      classes.splice(60, 0, ["Invoice", "Invoice#M"]);
      return { ...groupedRow("s1", "save", 2, classes), receiverText: "invoice", receiverGroup: "group-invoice" };
    };
    const isConfirm = (q: ResidualQuestion): boolean => q.siteKey.endsWith("/c.0");
    /** The first class at `first` for every block or menu, at `confirm` for the confirm question. */
    const answerWith =
      (first: { pick: "first" | null; p: number }, confirm: { pick: "first" | null; p: number }): Answer =>
      (q) => {
        const v = isConfirm(q) ? confirm : first;
        return { pick: v.pick === null ? null : (q.candidates[0] ?? null), p: v.p };
      };
    const confirmOn = { confirmStage: true };

    it("asks the mid block-1 pick again under its own key and accepts it on a confident confirm", async () => {
      const graphDb = fakeGraphDb([named()]);
      const provider = new FakeProvider(answerWith({ pick: "first", p: 0.6 }, { pick: "first", p: 0.9 }));

      const report = await run(graphDb, provider, confirmOn);

      const questions = provider.questions();
      expect(questions.map((q) => q.candidates)).toEqual([["Invoice"], ["Invoice"]]);
      expect(questions[0].siteKey).toMatch(/\/0\.0$/);
      expect(questions[1].siteKey).toMatch(/\/c\.0$/);
      expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["Invoice#save"]);
      expect(report).toMatchObject({
        earlyAcceptedGroups: 0,
        tournamentQuestions: 2,
        confirmQuestions: 1,
        confirmAccepted: 1,
      });
    });

    it("settles the group on a confirm below the accept threshold without asking a plain round", async () => {
      const provider = new FakeProvider(answerWith({ pick: "first", p: 0.6 }, { pick: "first", p: 0.6 }));

      const report = await run(fakeGraphDb([named()]), provider, confirmOn);

      expect(provider.questions()).toHaveLength(2);
      expect(report).toMatchObject({ sitesEdged: 0, confirmQuestions: 1, confirmAccepted: 0 });
    });

    it("keeps a confident none on the confirm question from marking the group's sites external", async () => {
      const graphDb = fakeGraphDb([named()]);
      const provider = new FakeProvider(answerWith({ pick: "first", p: 0.6 }, { pick: null, p: 0.95 }));

      const report = await run(graphDb, provider, confirmOn);

      expect(provider.questions()).toHaveLength(2);
      expect(report).toMatchObject({ sitesEdged: 0, externalByModel: 0, confirmAccepted: 0 });
    });

    it("leaves a tournament residual when block 1 is neither accepted nor mid, asking no plain round", async () => {
      const provider = new FakeProvider(answerWith({ pick: "first", p: 0.3 }, { pick: "first", p: 0.9 }));

      const report = await run(fakeGraphDb([named()]), provider, confirmOn);

      expect(provider.questions().map((q) => q.candidates)).toEqual([["Invoice"]]);
      expect(report).toMatchObject({ sitesEdged: 0, confirmQuestions: 0 });
    });

    it("asks nothing for a tournament the receiver's name does not open", async () => {
      const provider = new FakeProvider(answerWith({ pick: "first", p: 0.6 }, { pick: "first", p: 0.9 }));

      const report = await run(fakeGraphDb([groupedRow("u1", "save", 7, manyClasses(120))]), provider, confirmOn);

      expect(provider.calls).toHaveLength(0);
      expect(report).toMatchObject({ tournamentGroups: 1, tournamentQuestions: 0, sitesEdged: 0 });
    });

    it("asks a mid full-menu pick again and edges the group on a confident confirm", async () => {
      const graphDb = fakeGraphDb([groupedRow("s1", "save", 2)]);
      const provider = new FakeProvider(answerWith({ pick: "first", p: 0.6 }, { pick: "first", p: 0.9 }));

      const report = await run(graphDb, provider, confirmOn);

      const questions = provider.questions();
      expect(questions.map((q) => q.candidates)).toEqual([["Invoice", "Bill", "Estimate"], ["Invoice"]]);
      expect(questions[0].siteKey).not.toContain("/");
      expect(questions[1].siteKey).toBe(`${questions[0].siteKey}/c.0`);
      expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["Invoice#save"]);
      expect(report).toMatchObject({ confirmQuestions: 1, confirmAccepted: 1 });
    });

    it("keeps a confident full-menu none marking the group's sites external, with no confirm asked", async () => {
      const graphDb = fakeGraphDb([groupedRow("s1", "save", 2)]);
      const provider = new FakeProvider(answerWith({ pick: null, p: 0.95 }, { pick: "first", p: 0.9 }));

      const report = await run(graphDb, provider, confirmOn);

      expect(provider.questions()).toHaveLength(1);
      expect(report).toMatchObject({ externalByModel: 1, confirmQuestions: 0 });
    });

    it("charges the confirm question to the tournament budget", async () => {
      const provider = new FakeProvider(answerWith({ pick: "first", p: 0.6 }, { pick: "first", p: 0.9 }));

      const report = await run(fakeGraphDb([named()]), provider, { ...confirmOn, tournamentBudget: 1 });

      expect(provider.questions().map((q) => q.siteKey.slice(-4))).toEqual(["/0.0"]);
      expect(report).toMatchObject({ tournamentQuestions: 1, confirmQuestions: 0, sitesEdged: 0 });
    });

    it("resumes from the stored confirm verdict on the next run", async () => {
      const answer = answerWith({ pick: "first", p: 0.6 }, { pick: "first", p: 0.9 });
      await run(fakeGraphDb([named()]), new FakeProvider(answer), confirmOn);

      const graphDb = fakeGraphDb([named()]);
      const rerunProvider = new FakeProvider(answer);
      await run(graphDb, rerunProvider, confirmOn);

      expect(rerunProvider.calls).toHaveLength(0);
      expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["Invoice#save"]);
    });
  });

  describe("an accepted class propagates to the downstream hop", () => {
    const upstream = (returnType?: string) =>
      hopRow(
        "u1",
        "record",
        "firm",
        [
          returnType === undefined ? ["Client", "Client#firm"] : ["Client", "Client#firm", returnType],
          ["Contact", "Contact#firm", "Agency"],
        ],
        "group-record.firm",
      );
    const downstream = () =>
      hopRow("d1", "record.firm", "name", [
        ["Agency", "Agency#name"],
        ["Firm", "Firm#name"],
      ]);

    it("edges `record.firm.name` to Firm#name with the upstream verdict's p", async () => {
      const graphDb = fakeGraphDb([upstream("Firm"), downstream()]);
      const provider = new FakeProvider(answerByReceiver({ record: { pick: "Client", p: 0.9 } }));

      const report = await run(graphDb, provider);

      expect(edgeOf(graphDb.applied.at(-1), "u1")).toMatchObject({ targetSymbolId: "Client#firm", p: 0.9 });
      expect(edgeOf(graphDb.applied.at(-1), "d1")).toEqual({
        siteKey: "d1",
        sourceRelPath: "app/a.rb",
        sourceSymbolId: "A#run",
        targetSymbolId: "Firm#name",
        model: "kev",
        p: 0.9,
      });
      expect(report).toMatchObject({ sitesEdgedByVerdict: 1, sitesEdgedByPropagation: 1, propagationConflicts: 0 });
    });

    it("keeps the downstream group's own accepted verdict and counts the conflict", async () => {
      const graphDb = fakeGraphDb([upstream("Firm"), downstream()]);
      const provider = new FakeProvider(
        answerByReceiver({ record: { pick: "Client", p: 0.9 }, "record.firm": { pick: "Agency", p: 0.95 } }),
      );

      const report = await run(graphDb, provider);

      expect(edgeOf(graphDb.applied.at(-1), "d1")).toMatchObject({ targetSymbolId: "Agency#name", p: 0.95 });
      expect(report).toMatchObject({ sitesEdgedByVerdict: 2, sitesEdgedByPropagation: 0, propagationConflicts: 1 });
    });

    it("propagates nothing when the accepted class's return type is unknown", async () => {
      const graphDb = fakeGraphDb([upstream(), downstream()]);
      const provider = new FakeProvider(answerByReceiver({ record: { pick: "Client", p: 0.9 } }));

      const report = await run(graphDb, provider);

      expect(edgeOf(graphDb.applied.at(-1), "d1")).toBeUndefined();
      expect(report).toMatchObject({ sitesEdgedByPropagation: 0, propagationConflicts: 0 });
    });

    it("propagates nothing from a group accepted below the provider threshold", async () => {
      const graphDb = fakeGraphDb([upstream("Firm"), downstream()]);
      const provider = new FakeProvider(answerByReceiver({ record: { pick: "Client", p: 0.6 } }));

      const report = await run(graphDb, provider);

      expect(edgeOf(graphDb.applied.at(-1), "d1")).toBeUndefined();
      expect(report.sitesEdgedByPropagation).toBe(0);
    });

    it("carries `a.b.c.d` through two rounds and stops before a third", async () => {
      const graphDb = fakeGraphDb([
        hopRow(
          "s-b",
          "a",
          "b",
          [
            ["A", "A#b", "B"],
            ["W", "W#b"],
          ],
          "group-a.b",
        ),
        hopRow(
          "s-c",
          "a.b",
          "c",
          [
            ["B", "B#c", "C"],
            ["X", "X#c"],
          ],
          "group-a.b.c",
        ),
        hopRow(
          "s-d",
          "a.b.c",
          "d",
          [
            ["C", "C#d", "D"],
            ["Y", "Y#d"],
          ],
          "group-a.b.c.d",
        ),
        hopRow("s-e", "a.b.c.d", "e", [
          ["D", "D#e"],
          ["Z", "Z#e"],
        ]),
      ]);
      const provider = new FakeProvider(answerByReceiver({ a: { pick: "A", p: 0.88 } }));

      const report = await run(graphDb, provider);

      const applied = graphDb.applied.at(-1);
      expect(edgeOf(applied, "s-c")).toMatchObject({ targetSymbolId: "B#c", p: 0.88 });
      expect(edgeOf(applied, "s-d")).toMatchObject({ targetSymbolId: "C#d", p: 0.88 });
      expect(edgeOf(applied, "s-e")).toBeUndefined();
      expect(report.sitesEdgedByPropagation).toBe(2);
    });
  });

  describe("a class that reads the member as a schema column", () => {
    const externalOf = (graphDb: ReturnType<typeof fakeGraphDb>, siteKey: string) =>
      graphDb.external.at(-1)?.find((x) => x.siteKey === siteKey);

    it("moves a site whose picked class reads the member as a column to attributeByModel, with no edge", async () => {
      const graphDb = fakeGraphDb([
        hopRow("s-email", "user", "email", [
          ["User", null, "String"],
          ["Mailer", "Mailer#email"],
        ]),
        hopRow("s-login", "user", "login", [
          ["User", "User#login"],
          ["Mailer", "Mailer#login"],
        ]),
      ]);
      const provider = new FakeProvider(answerByReceiver({ user: { pick: "User", p: 0.9 } }));

      const report = await run(graphDb, provider);

      expect(edgeOf(graphDb.applied.at(-1), "s-email")).toBeUndefined();
      expect(edgeOf(graphDb.applied.at(-1), "s-login")).toMatchObject({ targetSymbolId: "User#login", p: 0.9 });
      expect(externalOf(graphDb, "s-email")).toEqual({
        siteKey: "s-email",
        sourceRelPath: "app/a.rb",
        menuHash: "menu-s-email",
        model: "kev",
        p: 0.9,
        outcome: "attribute",
      });
      expect(report).toMatchObject({ attributeByModel: 1, externalByModel: 0, sitesEdged: 1, belowThreshold: 0 });
    });

    it("settles `record.user.email` as an attribute from the upstream pick's return type", async () => {
      const graphDb = fakeGraphDb([
        hopRow("u1", "record", "user", [["Client", "Client#user", "User"]], "group-record.user"),
        hopRow("d1", "record.user", "email", [
          ["Admin", "Admin#email"],
          ["User", null, "String"],
        ]),
      ]);
      const provider = new FakeProvider(answerByReceiver({ record: { pick: "Client", p: 0.9 } }));

      const report = await run(graphDb, provider);

      expect(edgeOf(graphDb.applied.at(-1), "d1")).toBeUndefined();
      expect(externalOf(graphDb, "d1")).toMatchObject({ outcome: "attribute", p: 0.9 });
      expect(report).toMatchObject({ attributeByModel: 1, sitesEdgedByPropagation: 0 });
    });

    it("settles the hop after a core value type as external instead of searching a project menu", async () => {
      const graphDb = fakeGraphDb([
        hopRow(
          "u1",
          "record",
          "amount",
          [
            ["Invoice", null, "Integer"],
            ["Payment", "Payment#amount"],
          ],
          "group-record.amount",
        ),
        hopRow("d1", "record.amount", "round", [
          ["Money", "Money#round"],
          ["Calc", "Calc#round"],
        ]),
      ]);
      const provider = new FakeProvider(answerByReceiver({ record: { pick: "Invoice", p: 0.9 } }));

      const report = await run(graphDb, provider);

      expect(externalOf(graphDb, "u1")).toMatchObject({ outcome: "attribute", p: 0.9 });
      expect(externalOf(graphDb, "d1")).toEqual({
        siteKey: "d1",
        sourceRelPath: "app/a.rb",
        menuHash: "menu-d1",
        model: "kev",
        p: 0.9,
      });
      expect(edgeOf(graphDb.applied.at(-1), "d1")).toBeUndefined();
      expect(report).toMatchObject({ attributeByModel: 1, externalByPropagation: 1, externalByModel: 0 });
    });

    it("lets the downstream group's own accepted verdict stand over a core value type", async () => {
      const graphDb = fakeGraphDb([
        hopRow("u1", "record", "amount", [["Invoice", null, "Integer"]], "group-record.amount"),
        hopRow("d1", "record.amount", "round", [
          ["Money", "Money#round"],
          ["Calc", "Calc#round"],
        ]),
      ]);
      const provider = new FakeProvider(
        answerByReceiver({ record: { pick: "Invoice", p: 0.9 }, "record.amount": { pick: "Money", p: 0.95 } }),
      );

      const report = await run(graphDb, provider);

      expect(edgeOf(graphDb.applied.at(-1), "d1")).toMatchObject({ targetSymbolId: "Money#round" });
      expect(externalOf(graphDb, "d1")).toBeUndefined();
      expect(report).toMatchObject({ externalByPropagation: 0, propagationConflicts: 1 });
    });
  });
});
