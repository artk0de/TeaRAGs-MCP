/**
 * bd tea-rags-mcp-cm9gt.2: `get_architecture_report` restructurePlan mode — a
 * greedy ordered plan over candidate hypotheses. Each round judges
 * prefix ∪ candidate for every pool candidate and appends the best by the
 * lexicographic vector [net critical, net active, net structural], ties by
 * smaller blast radius, then id.
 *
 * Fixture (the one `architecture-restructure-ops.test.ts` judges): core and
 * base are stable, lib is unstable — two SDP violations (core → lib,
 * base → lib) — and lib/f5 calls back into core: one layering knot on core
 * with its back edge lib → core. No co-change history, so the real judge
 * tiers nothing; `tieredJudge` grades violations by key to pin the tier order.
 */
import { describe, expect, it, vi } from "vitest";

import { ArchitectureReportOps } from "../../../../../src/core/api/internal/ops/architecture-report-ops.js";
import { ArchitectureRestructureOps } from "../../../../../src/core/api/internal/ops/architecture-restructure-ops.js";
import { ArchitectureRestructurePlanOps } from "../../../../../src/core/api/internal/ops/architecture-restructure-plan-ops.js";
import type {
  ArchitectureRestructurePlanCandidate,
  ArchitectureViolationImpactTier,
  GetArchitectureReportRequest,
  SplitMergeVerdictsSummary,
} from "../../../../../src/core/api/public/dto/architecture.js";
import { InvalidParameterError, UnknownRestructureEdgeError } from "../../../../../src/core/api/public/errors.js";
import { architectureViolationKey } from "../../../../../src/core/contracts/types/architecture-finding-key.js";
import type { FileDependencyGraph, TemporalCochangeGraph } from "../../../../../src/core/contracts/types/codegraph.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function graph(): FileDependencyGraph {
  const files = [file("core/a.ts"), file("core/b.ts"), file("base/a.ts"), file("other/o.ts"), file("vendor/v.ts")];
  const edges: FileDependencyGraph["edges"] = [];
  const add = (sourceRelPath: string, targetRelPath: string, callWeight = 1) => {
    edges.push({ sourceRelPath, targetRelPath, callWeight });
  };
  add("core/a.ts", "lib/f1.ts", 2);
  add("core/b.ts", "lib/f2.ts");
  add("base/a.ts", "lib/f4.ts", 3);
  add("other/o.ts", "lib/f3.ts");
  for (let i = 1; i <= 6; i++) {
    files.push(file(`app/c${i}.ts`), file(`users/u${i}.ts`));
    add(`app/c${i}.ts`, "core/b.ts");
    add(`users/u${i}.ts`, "base/a.ts");
  }
  for (let i = 1; i <= 5; i++) {
    files.push(file(`lib/f${i}.ts`));
    add(`lib/f${i}.ts`, "vendor/v.ts");
  }
  add("lib/f5.ts", "core/a.ts");
  return { files, edges };
}

function graphDb() {
  const cochange: TemporalCochangeGraph = { meta: null, edges: [] };
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue(graph()),
    readNonPublicMemberEdges: vi.fn().mockResolvedValue([]),
    readTemporalCochangeGraph: vi.fn().mockResolvedValue(cochange),
    readTypeNameRows: vi.fn().mockResolvedValue([]),
  };
}

const SDP_CORE = 'stableDependencies@1:["core","lib"]';

/** The real judge, with each violation's tier set by its key and, optionally, split/merge verdicts on the summary. */
function tieredJudge(
  tierOf: (key: string) => ArchitectureViolationImpactTier | undefined = () => undefined,
  verdicts?: SplitMergeVerdictsSummary,
) {
  const real = new ArchitectureReportOps();
  const judge = vi.fn(async (...args: Parameters<ArchitectureReportOps["judge"]>) => {
    const response = await real.judge(...args);
    return {
      ...response,
      violations: response.violations.map((violation) => {
        const tier = tierOf(architectureViolationKey(violation));
        return tier === undefined ? violation : { ...violation, tier };
      }),
      summary: verdicts ? { ...response.summary, splitMerge: { built: true, verdicts } } : response.summary,
    };
  });
  return { judge } as unknown as ArchitectureReportOps & { judge: typeof judge };
}

const CUT_BASE: ArchitectureRestructurePlanCandidate["ops"] = [{ removeEdge: { from: "base/a.ts", to: "lib/f4.ts" } }];
const CUT_CORE: ArchitectureRestructurePlanCandidate["ops"] = [
  { removeEdge: { from: "core/a.ts", to: "lib/f1.ts" } },
  { removeEdge: { from: "core/b.ts", to: "lib/f2.ts" } },
];
const CUT_BACK_EDGE: ArchitectureRestructurePlanCandidate["ops"] = [
  { removeEdge: { from: "lib/f5.ts", to: "core/a.ts" } },
];

function planRequest(
  candidates: ArchitectureRestructurePlanCandidate[],
  includeReportCandidates = false,
): GetArchitectureReportRequest {
  return { restructurePlan: { candidates, includeReportCandidates } };
}

describe("ArchitectureRestructurePlanOps#plan", () => {
  it("tier order beats raw count: one critical resolved outranks three structural", async () => {
    // premise: alone, a-structural nets at least as many resolved as b-critical — on raw count
    // (and on the id tie-break) a-structural would come first
    const alone = async (restructure: ArchitectureRestructurePlanCandidate["ops"]) =>
      -(await new ArchitectureRestructureOps().simulate(graphDb(), { restructure })).delta!.net;
    expect(await alone([...CUT_BASE, ...CUT_BACK_EDGE])).toBeGreaterThanOrEqual(3);
    expect(await alone([...CUT_BASE, ...CUT_BACK_EDGE])).toBeGreaterThanOrEqual(await alone(CUT_CORE));

    const ops = new ArchitectureRestructurePlanOps(tieredJudge((key) => (key === SDP_CORE ? "critical" : undefined)));
    const answer = await ops.plan(
      graphDb(),
      planRequest([
        { id: "a-structural", ops: [...CUT_BASE, ...CUT_BACK_EDGE] },
        { id: "b-critical", ops: CUT_CORE },
      ]),
    );

    expect(answer.mode).toBe("restructurePlan");
    expect(answer.steps[0].candidateId).toBe("b-critical");
    expect(answer.steps[0].delta.byTier.critical).toEqual({ resolved: 1, introduced: 0 });
    expect(answer.steps[0].source).toBe("caller");
  });

  it("breaks a tie on equal vectors by the smaller blast radius", async () => {
    const readFileTransitiveImpacts = vi.fn(
      async (relPaths: readonly string[]) =>
        new Map(relPaths.map((relPath) => [relPath, relPath === "core/a.ts" ? 100 : 1])),
    );
    const answer = await new ArchitectureRestructurePlanOps(tieredJudge()).plan(
      graphDb(),
      planRequest([
        { id: "a-wide", ops: [...CUT_BASE, { addEdge: { from: "app/c1.ts", to: "core/a.ts" } }] },
        { id: "b-narrow", ops: CUT_BASE },
      ]),
      { readFileTransitiveImpacts },
    );

    expect(answer.steps[0]).toMatchObject({
      candidateId: "b-narrow",
      touchedFiles: ["base/a.ts", "lib/f4.ts"],
      blastRadius: 2,
    });
  });

  it("a merge's blast radius counts the files it relabels: the merge relabelling more files loses the tie", async () => {
    // every relabelled run resolves the whole base: both candidates net the same vector
    const real = new ArchitectureReportOps();
    const judge = vi.fn(async (...args: Parameters<ArchitectureReportOps["judge"]>) => {
      const response = await real.judge(...args);
      return args[0].componentRelabel === undefined ? response : { ...response, violations: [] };
    });
    const readFileTransitiveImpacts = vi.fn(
      async (relPaths: readonly string[]) => new Map(relPaths.map((relPath) => [relPath, 1])),
    );
    const answer = await new ArchitectureRestructurePlanOps({ judge }).plan(
      graphDb(),
      planRequest([
        { id: "a-merge", ops: [{ merge: { components: ["vendor", "app"] } }] },
        { id: "b-move", ops: [{ move: { files: ["other/o.ts"], toComponent: "vendor" } }] },
      ]),
      { readFileTransitiveImpacts },
    );

    expect(answer.steps[0]).toMatchObject({ candidateId: "b-move", touchedFiles: ["other/o.ts"], blastRadius: 1 });
    expect(answer.unselected).toEqual([{ candidateId: "a-merge", source: "caller", reason: "noImprovement" }]);

    const mergeOnly = await new ArchitectureRestructurePlanOps({ judge }).plan(
      graphDb(),
      planRequest([{ id: "a-merge", ops: [{ merge: { components: ["vendor", "app"] } }] }]),
      { readFileTransitiveImpacts },
    );
    expect(mergeOnly.steps[0]).toMatchObject({
      touchedFiles: ["app/c1.ts", "app/c2.ts", "app/c3.ts", "app/c4.ts", "app/c5.ts", "app/c6.ts"],
      blastRadius: 6,
    });
  });

  it("never selects a trade-off — a candidate introducing an active violation lands in tradeOffs", async () => {
    const ops = new ArchitectureRestructurePlanOps(
      tieredJudge((key) => (key.startsWith('stableDependencies@1:["vendor"') ? "active" : undefined)),
    );
    const answer = await ops.plan(
      graphDb(),
      planRequest([
        // resolves both SDP violations, but vendor → lib is introduced: a trade-off however good its net
        { id: "harmful", ops: [...CUT_BASE, ...CUT_CORE, { addEdge: { from: "vendor/v.ts", to: "lib/f1.ts" } }] },
        { id: "safe", ops: CUT_BASE },
      ]),
    );

    expect(answer.steps.map((step) => step.candidateId)).toEqual(["safe"]);
    expect(answer.tradeOffs).toHaveLength(1);
    expect(answer.tradeOffs[0]).toMatchObject({ candidateId: "harmful", source: "caller" });
    expect(answer.tradeOffs[0].delta.byTier.active.introduced).toBe(1);
  });

  it("a candidate made redundant by an earlier step is unselected as noImprovement", async () => {
    const answer = await new ArchitectureRestructurePlanOps(tieredJudge()).plan(
      graphDb(),
      planRequest([
        { id: "both", ops: [...CUT_BASE, ...CUT_CORE] },
        { id: "base-only-move", ops: [{ move: { files: ["lib/f4.ts"], toComponent: "vendor" } }] },
      ]),
    );

    expect(answer.steps.map((step) => step.candidateId)).toEqual(["both"]);
    expect(answer.unselected).toEqual([{ candidateId: "base-only-move", source: "caller", reason: "noImprovement" }]);
  });

  it("two candidates removing the same edge: the second conflicts with the prefix", async () => {
    const answer = await new ArchitectureRestructurePlanOps(tieredJudge()).plan(
      graphDb(),
      planRequest([
        { id: "cut-and-back", ops: [...CUT_BASE, ...CUT_BACK_EDGE] },
        { id: "cut-only", ops: CUT_BASE },
      ]),
    );

    expect(answer.steps.map((step) => step.candidateId)).toEqual(["cut-and-back"]);
    expect(answer.unselected).toHaveLength(1);
    expect(answer.unselected[0]).toMatchObject({ candidateId: "cut-only", reason: "conflictsWithPrefix" });
    expect(answer.unselected[0].detail).toMatch(/base\/a\.ts/);
  });

  it("stops with candidates left when none improves", async () => {
    const answer = await new ArchitectureRestructurePlanOps(tieredJudge()).plan(
      graphDb(),
      planRequest([{ id: "noop", ops: [{ addEdge: { from: "base/a.ts", to: "vendor/v.ts" } }] }]),
    );

    expect(answer.steps).toEqual([]);
    expect(answer.unselected).toEqual([{ candidateId: "noop", source: "caller", reason: "noImprovement" }]);
    expect(answer.total.net).toBe(0);
    expect(answer.total.byTier.structural).toEqual({ resolved: 0, introduced: 0 });
  });

  it("orders equal vectors and equal blast radius by id", async () => {
    const answer = await new ArchitectureRestructurePlanOps(tieredJudge()).plan(
      graphDb(),
      planRequest([
        { id: "zeta", ops: CUT_BASE },
        { id: "alpha", ops: CUT_BASE },
      ]),
    );

    expect(answer.steps.map((step) => step.candidateId)).toEqual(["alpha"]);
    expect(answer.unselected[0]).toMatchObject({ candidateId: "zeta", reason: "conflictsWithPrefix" });
  });

  it("builds report split/merge candidates by default and none when includeReportCandidates is false", async () => {
    const verdicts: SplitMergeVerdictsSummary = {
      splitCandidates: [{ component: "lib", clusters: 2, largestWeightShare: 0.6, files: [["lib/f5.ts"]] }],
      mergeCandidates: [{ componentA: "core", componentB: "lib", support: 4, strength: 0.7, changesA: 5, changesB: 5 }],
      threshold: 0.5,
      thresholdMethod: "majority",
      excluded: { unpartitionedEndpoints: 0, crossComponentPairs: 0 },
    };
    const ids = (answer: Awaited<ReturnType<ArchitectureRestructurePlanOps["plan"]>>) =>
      [...answer.steps, ...answer.tradeOffs, ...answer.unselected].map((entry) => entry.candidateId).sort();

    const withReport = await new ArchitectureRestructurePlanOps(tieredJudge(undefined, verdicts)).plan(graphDb(), {
      restructurePlan: { candidates: [] },
    });
    expect(ids(withReport)).toEqual(["report:merge:1", "report:split:1"]);
    const split = [...withReport.steps, ...withReport.tradeOffs, ...withReport.unselected].find(
      (entry) => entry.candidateId === "report:split:1",
    );
    expect(split?.source).toBe("report");

    const without = await new ArchitectureRestructurePlanOps(tieredJudge(undefined, verdicts)).plan(
      graphDb(),
      planRequest([{ id: "cut", ops: CUT_BASE }]),
    );
    expect(ids(without).some((id) => id.startsWith("report:"))).toBe(false);
  });

  it("counts every judge call: 1 base + the pool size of every round", async () => {
    const judge = tieredJudge();
    const answer = await new ArchitectureRestructurePlanOps(judge).plan(
      graphDb(),
      planRequest([
        { id: "base", ops: CUT_BASE },
        { id: "core", ops: CUT_CORE },
      ]),
    );

    // round 1: pool 2, round 2: pool 1, round 3: pool empty
    expect(answer.steps).toHaveLength(2);
    expect(answer.timing.judgeCount).toBe(1 + 2 + 1);
    expect(judge.judge).toHaveBeenCalledTimes(4);
  });

  it("a step's delta is vs the prefix before it, total is base vs the final prefix", async () => {
    const answer = await new ArchitectureRestructurePlanOps(tieredJudge()).plan(
      graphDb(),
      planRequest([
        { id: "base", ops: CUT_BASE },
        { id: "core", ops: CUT_CORE },
      ]),
    );

    const resolvedSubjects = answer.total.resolved.map((subject) => subject.subject);
    expect(resolvedSubjects).toEqual(expect.arrayContaining(["base → lib", "core → lib"]));
    // each SDP violation is resolved by exactly one step: the second step's delta does not re-count the first's
    const sdpResolvedPerStep = answer.steps.map(
      (step) => step.delta.resolved.filter((subject) => subject.family === "stableDependencies").length,
    );
    expect(sdpResolvedPerStep).toEqual([1, 1]);
  });
});

describe("ArchitectureRestructurePlanOps — validation", () => {
  const ops = () => new ArchitectureRestructurePlanOps(tieredJudge());

  it("is exclusive with restructure, plannedEdges and every report-only option", async () => {
    for (const riding of [
      { restructure: CUT_BASE },
      { plannedEdges: [{ source: "a.ts", target: "b.ts" }] },
      { pathPattern: "lib/**" },
      { domain: "lib" },
      { norms: true },
      { changeReasons: true },
      { layerMap: {} },
      { knotOf: "core" },
      { offset: 1 },
    ] as Partial<GetArchitectureReportRequest>[]) {
      await expect(
        ops().plan(graphDb(), { ...planRequest([{ id: "c", ops: CUT_BASE }]), ...riding }),
      ).rejects.toBeInstanceOf(InvalidParameterError);
    }
  });

  it("rejects duplicate ids, report: ids, empty or over-cap candidates, and an empty pool", async () => {
    const reject = async (candidates: ArchitectureRestructurePlanCandidate[], include = false) =>
      expect(ops().plan(graphDb(), planRequest(candidates, include))).rejects.toBeInstanceOf(InvalidParameterError);
    await reject([
      { id: "a", ops: CUT_BASE },
      { id: "a", ops: CUT_CORE },
    ]);
    await reject([{ id: "report:split:1", ops: CUT_BASE }]);
    await reject([{ id: "empty", ops: [] }]);
    await reject([{ id: "long", ops: Array.from({ length: 21 }, () => CUT_BASE[0]) }]);
    await reject(
      Array.from({ length: 51 }, (_, k) => ({ id: `c${k}`, ops: CUT_BASE })),
      true,
    );
    await reject([]);
  });

  it("a caller candidate that does not compile against the base is the caller's error", async () => {
    await expect(
      ops().plan(
        graphDb(),
        planRequest([{ id: "bad", ops: [{ removeEdge: { from: "core/a.ts", to: "core/b.ts" } }] }]),
      ),
    ).rejects.toBeInstanceOf(UnknownRestructureEdgeError);
  });
});

describe("ArchitectureRestructurePlanOps.unavailable", () => {
  it("answers the mode with empty arrays when no codegraph can be read", () => {
    const answer = ArchitectureRestructurePlanOps.unavailable(planRequest([{ id: "c", ops: CUT_BASE }]));
    expect(answer).toMatchObject({ mode: "restructurePlan", steps: [], tradeOffs: [], unselected: [] });
    expect(answer.unavailable).toBe("noCodegraph");
    expect(answer.timing.judgeCount).toBe(0);
  });
});
