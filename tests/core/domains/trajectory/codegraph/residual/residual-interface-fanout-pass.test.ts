import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import type {
  ModelEdgeRow,
  ResidualCallSiteRow,
  ResidualClassTarget,
} from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import type { ResidualClassTieReader } from "../../../../../../src/core/domains/trajectory/codegraph/residual/interface-fanout.js";
import {
  ResidualResolutionPass,
  type ResidualPassInput,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestionGroup,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/types.js";

/** Answers every class question with one distribution; the pick is its most probable class. */
class DistributionProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold = 0.7;
  asked = 0;

  constructor(private readonly probabilities: Record<string, number>) {}

  version = async () => "fake@1";
  health = async (): Promise<{ ok: true }> => ({ ok: true });

  resolveGroup = async (group: ResidualQuestionGroup): Promise<ResidualAnswer[]> =>
    group.questions.map((q) => {
      this.asked++;
      const [top, p] = Object.entries(this.probabilities).sort((a, b) => b[1] - a[1])[0];
      const pick = top === "(none)" ? null : top;
      return { siteKey: q.siteKey, pick, p, probabilities: this.probabilities, questionPayload: "{}" };
    });
}

function fakeGraphDb(rows: ResidualCallSiteRow[]) {
  const applied: ModelEdgeRow[][] = [];
  return {
    applied,
    readResidualCallSites: async () => rows,
    applyModelEdges: async (_model: string, edges: ModelEdgeRow[]) => {
      applied.push(edges);
      return { stored: edges.length, changed: true };
    },
    applyModelExternalSites: async () => undefined,
    markDerivedStale: async () => undefined,
  };
}

const TARGETS: ResidualClassTarget[] = [
  ["Alpha", "Alpha#firm"],
  ["Beta", "Beta#firm"],
  ["Gamma", "Gamma#firm"],
  ["Delta", "Delta#firm"],
];

function actorRow(siteKey: string, line: number, classTargets = TARGETS): ResidualCallSiteRow {
  return {
    siteKey,
    sourceRelPath: "app/a.rb",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 20,
    line,
    column: 4,
    receiverText: "@actor",
    member: "firm",
    kind: "dynamic",
    candidates: classTargets.flatMap(([, t]) => (t === null ? [] : [t])),
    menuHash: `menu-${siteKey}`,
    menuOverflow: false,
    receiverGroup: "group-actor",
    classTargets,
  };
}

const POLYMORPHIC: ResidualClassTieReader = {
  tiesOf: async (classes) =>
    new Map(classes.map((c) => [c, new Set(c === "Beta" || c === "Delta" ? ["as:actor"] : [])])),
};

describe("ResidualResolutionPass — polymorphic interface fan-out", () => {
  let rootDir: string;
  let store: ResidualVerdictStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-fanout-pass-"));
    store = await ResidualVerdictStore.open(rootDir, "code_test");
  });

  afterEach(async () => {
    await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  const run = async (
    graphDb: ReturnType<typeof fakeGraphDb>,
    provider: ResidualModelProvider,
    over: Partial<Omit<ResidualPassInput, "graphDb" | "store" | "provider">> = {},
  ) =>
    new ResidualResolutionPass().run({
      graphDb,
      store,
      provider,
      mode: "ask",
      concurrency: 1,
      menuLimit: 40,
      minMenu: 1,
      noneThreshold: 0.8,
      retentionDays: 180,
      recomputeDerived: async () => undefined,
      readMethodSource: async () => "def run\n  @actor.firm\nend",
      now: () => 1_000,
      ...over,
    });

  it("edges every interface class with the summed p when no single class clears the threshold", async () => {
    const graphDb = fakeGraphDb([actorRow("s1", 2)]);
    const provider = new DistributionProvider({ Beta: 0.55, Delta: 0.35, Alpha: 0.05, Gamma: 0.05 });

    const report = await run(graphDb, provider, { classTies: POLYMORPHIC, fanoutFloor: 0.15 });

    expect(graphDb.applied.at(-1)).toEqual([
      {
        siteKey: "s1",
        sourceRelPath: "app/a.rb",
        sourceSymbolId: "A#run",
        targetSymbolId: "Beta#firm",
        model: "kev",
        p: 0.9,
        fanout: 2,
      },
      {
        siteKey: "s1",
        sourceRelPath: "app/a.rb",
        sourceSymbolId: "A#run",
        targetSymbolId: "Delta#firm",
        model: "kev",
        p: 0.9,
        fanout: 2,
      },
    ]);
    expect(report).toMatchObject({
      fanoutGroups: 1,
      fanoutEdges: 2,
      sitesEdged: 1,
      sitesEdgedByVerdict: 1,
      belowThreshold: 0,
    });
  });

  it("replaces an accepted single-class edge with the fan-out", async () => {
    const graphDb = fakeGraphDb([actorRow("s1", 2), actorRow("s2", 3)]);
    const provider = new DistributionProvider({ Beta: 0.75, Delta: 0.2, Alpha: 0.05 });

    const report = await run(graphDb, provider, { classTies: POLYMORPHIC, fanoutFloor: 0.15 });

    expect(graphDb.applied.at(-1)?.map((e) => [e.siteKey, e.targetSymbolId, e.fanout])).toEqual([
      ["s1", "Beta#firm", 2],
      ["s1", "Delta#firm", 2],
      ["s2", "Beta#firm", 2],
      ["s2", "Delta#firm", 2],
    ]);
    expect(report).toMatchObject({ fanoutGroups: 1, fanoutEdges: 4, sitesEdged: 2 });
  });

  it("keeps the single-class edge without a tie reader", async () => {
    const graphDb = fakeGraphDb([actorRow("s1", 2)]);
    const provider = new DistributionProvider({ Beta: 0.75, Delta: 0.2, Alpha: 0.05 });

    const report = await run(graphDb, provider);

    expect(graphDb.applied.at(-1)?.map((e) => [e.targetSymbolId, e.p, e.fanout])).toEqual([
      ["Beta#firm", 0.75, undefined],
    ]);
    expect(report).toMatchObject({ fanoutGroups: 0, fanoutEdges: 0 });
  });

  it("does not fan out under a floor raised above the second class", async () => {
    const graphDb = fakeGraphDb([actorRow("s1", 2)]);
    const provider = new DistributionProvider({ Beta: 0.75, Delta: 0.2, Alpha: 0.05 });

    await run(graphDb, provider, { classTies: POLYMORPHIC, fanoutFloor: 0.25 });

    expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["Beta#firm"]);
  });

  it("writes one plain edge where the interface classes reach the member through one definition", async () => {
    const shared: ResidualClassTarget[] = [
      ["Alpha", "Alpha#firm"],
      ["Beta", "Person#firm"],
      ["Delta", "Person#firm"],
    ];
    const graphDb = fakeGraphDb([actorRow("s1", 2, shared)]);
    const provider = new DistributionProvider({ Beta: 0.5, Delta: 0.4, Alpha: 0.1 });

    const report = await run(graphDb, provider, { classTies: POLYMORPHIC, fanoutFloor: 0.15 });

    expect(graphDb.applied.at(-1)?.map((e) => [e.targetSymbolId, e.p, e.fanout])).toEqual([
      ["Person#firm", 0.9, undefined],
    ]);
    expect(report).toMatchObject({ fanoutGroups: 1, fanoutEdges: 0 });
  });

  it("fans out on the full-menu answer even when the confirm stage re-asks its mid pick", async () => {
    const graphDb = fakeGraphDb([actorRow("s1", 2)]);
    const provider = new DistributionProvider({ Beta: 0.55, Delta: 0.35, Alpha: 0.1 });

    const report = await run(graphDb, provider, { classTies: POLYMORPHIC, confirmStage: true, fanoutFloor: 0.15 });

    expect(provider.asked).toBe(2);
    expect(graphDb.applied.at(-1)?.map((e) => [e.targetSymbolId, e.p])).toEqual([
      ["Beta#firm", 0.9],
      ["Delta#firm", 0.9],
    ]);
    expect(report).toMatchObject({ confirmQuestions: 1, fanoutGroups: 1 });
  });

  it("never fans out a group whose none answer is accepted as external", async () => {
    const graphDb = fakeGraphDb([actorRow("s1", 2)]);
    const provider = new DistributionProvider({ "(none)": 0.85, Beta: 0.08, Delta: 0.07 });

    const report = await run(graphDb, provider, { classTies: POLYMORPHIC, fanoutFloor: 0.05 });

    expect(report).toMatchObject({ fanoutGroups: 0, externalByModel: 1 });
  });

  it("asks the same question with or without the tie reader, so cached verdicts stay valid", async () => {
    const provider = new DistributionProvider({ Beta: 0.55, Delta: 0.35, Alpha: 0.1 });
    await run(fakeGraphDb([actorRow("s1", 2)]), provider);
    expect(provider.asked).toBe(1);

    const graphDb = fakeGraphDb([actorRow("s1", 2)]);
    await run(graphDb, provider, { classTies: POLYMORPHIC, fanoutFloor: 0.15 });

    expect(provider.asked).toBe(1);
    expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual(["Beta#firm", "Delta#firm"]);
  });
});
