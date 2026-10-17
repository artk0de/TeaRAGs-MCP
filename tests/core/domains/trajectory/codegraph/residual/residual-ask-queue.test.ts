import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import type {
  ModelEdgeRow,
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

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface Timing {
  /** Milliseconds per question, whatever its menu. */
  perQuestion: number;
  /** Milliseconds per candidate of a question. */
  perCriterion: number;
}

/**
 * A model server whose request time grows with questions × criteria — state is
 * re-encoded per question — and that records the shape of every request.
 */
class TimedProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold = 0.7;
  readonly requests: { method: string; questions: number; criteria: number; inFlightAtEntry: number }[] = [];
  readonly answeredKeys: string[] = [];
  readonly answered: { siteKey: string; menuHash: string }[] = [];
  inFlight = 0;
  /** Requests started after this many answered questions fail as a lost session. */
  failAfterAnswers = Number.POSITIVE_INFINITY;
  /** Requests the server works on at once (its GPU); the rest wait in its queue. */
  lanes = Number.POSITIVE_INFINITY;
  /** A request that took longer than this, server queue included, fails as a timeout. */
  timeoutMs = Number.POSITIVE_INFINITY;

  constructor(
    private readonly truth: (q: ResidualQuestion) => string | undefined,
    private readonly timing: (q: ResidualQuestionGroup) => number,
  ) {}

  version = async () => "fake@1";
  health = async (): Promise<{ ok: true }> => ({ ok: true });

  resolveGroup = async (group: ResidualQuestionGroup): Promise<ResidualAnswer[]> => {
    if (this.answeredKeys.length >= this.failAfterAnswers) {
      throw Object.assign(new Error("session lost"), { code: "INFRA_KEV_SESSION_LOST" });
    }
    const enteredAt = Date.now();
    this.inFlight++;
    this.requests.push({
      method: group.methodSymbolId,
      questions: group.questions.length,
      criteria: group.questions.reduce((n, q) => n + q.candidates.length, 0),
      inFlightAtEntry: this.inFlight,
    });
    try {
      // Processor sharing: the GPU's `lanes` are split over every request in flight.
      await sleep(this.timing(group) * Math.max(1, this.inFlight / this.lanes));
    } finally {
      this.inFlight--;
    }
    if (Date.now() - enteredAt > this.timeoutMs) {
      throw Object.assign(new Error("timed out"), { code: "INFRA_KEV_TIMEOUT" });
    }
    return group.questions.map((q) => {
      this.answeredKeys.push(q.siteKey);
      this.answered.push({ siteKey: q.siteKey, menuHash: q.menuHash });
      const truth = this.truth(q);
      const pick = truth !== undefined && q.candidates.includes(truth) ? truth : (q.candidates[0] ?? null);
      const p = pick === truth ? 0.9 : 0.3;
      return { siteKey: q.siteKey, pick, p, probabilities: { [pick ?? "(none)"]: p }, questionPayload: "{}" };
    });
  };
}

const workTime =
  ({ perQuestion, perCriterion }: Timing) =>
  (group: ResidualQuestionGroup): number =>
    group.questions.reduce((ms, q) => ms + perQuestion + perCriterion * q.candidates.length, 0);

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

const className = (group: number, i: number) => `G${group}K${String(i).padStart(3, "0")}`;

/** One receiver group of `classes` classes in its own method `M#g<group>`; the truth is its last class. */
function groupRow(group: number, classes: number): ResidualCallSiteRow {
  const classTargets = Array.from({ length: classes }, (_, i): [string, string] => [
    className(group, i),
    `${className(group, i)}#save`,
  ]);
  return {
    siteKey: `g${group}`,
    sourceRelPath: `app/g${group}.rb`,
    methodSymbolId: `M#g${group}`,
    methodStartLine: 1,
    methodEndLine: 20,
    line: 5,
    column: 4,
    receiverText: "record",
    member: "save",
    kind: "dynamic",
    candidates: classTargets.slice(0, 40).map(([, t]) => t),
    menuHash: `menu-g${group}`,
    menuOverflow: classes > 40,
    receiverGroup: `group-${group}`,
    classTargets,
  };
}

/** A per-site question with `candidates` candidates in `method`. */
function siteRow(siteKey: string, method: string, candidates = 3): ResidualCallSiteRow {
  return {
    siteKey,
    sourceRelPath: `app/${method}.rb`,
    methodSymbolId: method,
    methodStartLine: 1,
    methodEndLine: 20,
    line: 5,
    column: 4,
    receiverText: "x",
    member: "go",
    kind: "dynamic",
    candidates: Array.from({ length: candidates }, (_, i) => `${method}T${i}#go`),
    menuHash: `menu-${siteKey}`,
    menuOverflow: false,
  };
}

/** The last class of a receiver group, or a site's first candidate. */
const truthOf =
  (rows: ResidualCallSiteRow[]) =>
  (q: ResidualQuestion): string | undefined => {
    if (q.subject !== "class") return q.candidates[0];
    for (const row of rows) {
      const last = row.classTargets?.at(-1)?.[0];
      if (last !== undefined && q.candidates.includes(last)) return last;
    }
    return undefined;
  };

describe("ResidualResolutionPass — request caps and the shared work queue", () => {
  let rootDir: string;
  let store: ResidualVerdictStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-ask-queue-"));
    store = await ResidualVerdictStore.open(rootDir, "code_test");
  });

  afterEach(async () => {
    await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  const run = async (
    rows: ResidualCallSiteRow[],
    provider: TimedProvider,
    over: Partial<Omit<ResidualPassInput, "graphDb" | "store" | "provider">> = {},
  ) => {
    const graphDb = fakeGraphDb(rows);
    const report = await new ResidualResolutionPass().run({
      graphDb,
      store,
      provider,
      mode: "ask",
      concurrency: 4,
      menuLimit: 40,
      minMenu: 1,
      noneThreshold: 0.8,
      retentionDays: 180,
      recomputeDerived: async () => undefined,
      readMethodSource: async () => "def run\nend",
      now: () => Date.now(),
      ...over,
    });
    return { report, graphDb };
  };

  const fast = workTime({ perQuestion: 0, perCriterion: 0 });

  it("caps every request by questions and by criteria, a tournament round spread over several requests", async () => {
    const rows = [groupRow(1, 451)];
    const provider = new TimedProvider(truthOf(rows), fast);

    const { report, graphDb } = await run(rows, provider, {
      maxQuestionsPerRequest: 8,
      maxCriteriaPerRequest: 120,
    });

    const roundOne = provider.requests.slice(0, -1);
    expect(roundOne.map((r) => r.questions)).toEqual([3, 3, 3, 3]);
    expect(provider.requests.every((r) => r.criteria <= 120)).toBe(true);
    expect(report).toMatchObject({ requests: 5, maxQuestionsPerRequest: 3, tournamentRounds: 2, sitesEdged: 1 });
    expect(graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual([`${className(1, 450)}#save`]);
  });

  it("keeps a method under the caps in one request and never merges two methods", async () => {
    const rows = [siteRow("a1", "A#run"), siteRow("a2", "A#run"), siteRow("a3", "A#run"), siteRow("b1", "B#run")];
    const provider = new TimedProvider(truthOf(rows), fast);

    const { report } = await run(rows, provider);

    expect(provider.requests.map((r) => [r.method, r.questions])).toEqual([
      ["A#run", 3],
      ["B#run", 1],
    ]);
    expect(report).toMatchObject({ requests: 2, maxQuestionsPerRequest: 3, sitesEdged: 4 });
  });

  it("splits a method's questions once they exceed the question cap", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => siteRow(`a${i}`, "A#run"));
    const provider = new TimedProvider(truthOf(rows), fast);

    await run(rows, provider, { maxQuestionsPerRequest: 2 });

    expect(provider.requests.map((r) => r.questions)).toEqual([2, 2, 1]);
  });

  it("keeps the pool saturated across a tournament round boundary while work is queued", async () => {
    const rows = [groupRow(1, 120), ...Array.from({ length: 24 }, (_, i) => siteRow(`s${i}`, `S#m${i}`))];
    // A tournament block answers at once; a site question takes 15 ms.
    const provider = new TimedProvider(truthOf(rows), (g) => (g.questions[0]?.subject === "class" ? 0 : 15));

    const { report } = await run(rows, provider, { concurrency: 4, maxQuestionsPerRequest: 1 });

    const roundTwo = provider.requests.findIndex((r) => r.method === "M#g1" && r.criteria === 1);
    expect(roundTwo).toBeGreaterThan(0);
    // Site requests are still in flight when round 2 goes out; a barrier would send it alone.
    expect(provider.requests[roundTwo].inFlightAtEntry).toBeGreaterThan(1);
    expect(roundTwo).toBeLessThan(provider.requests.length - 1);
    expect(report.peakInFlight).toBe(4);
    expect(report.sitesEdged).toBe(25);
  });

  it("stores every answered block before the pass stops, and a rerun resumes the tournament from them", async () => {
    const rows = [groupRow(1, 451)];
    const provider = new TimedProvider(truthOf(rows), fast);
    provider.failAfterAnswers = 6;

    const first = await run(rows, provider, { concurrency: 1, maxQuestionsPerRequest: 3 });

    expect(first.report.outcome).toBe("skipped");
    const answered = new Set(provider.answeredKeys);
    expect(answered.size).toBe(6);
    const stored = await store.find(provider.answered.map((k) => ({ ...k, modelVersion: "fake@1" })));
    expect(stored.map((v) => v.siteKey).sort()).toEqual([...answered].sort());

    const rerunProvider = new TimedProvider(truthOf(rows), fast);
    const second = await run(rows, rerunProvider, { concurrency: 1, maxQuestionsPerRequest: 3 });

    const reasked = rerunProvider.answeredKeys.filter((k) => answered.has(k));
    expect(reasked).toEqual([]);
    expect(rerunProvider.answeredKeys).toHaveLength(12 - 6 + 1);
    expect(second.report).toMatchObject({ outcome: "completed", groupCacheHits: 6, sitesEdged: 1 });
    expect(second.graphDb.applied.at(-1)?.map((e) => e.targetSymbolId)).toEqual([`${className(1, 450)}#save`]);
  });

  it("reports request latency percentiles", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => siteRow(`s${i}`, `S#m${i}`));
    const provider = new TimedProvider(truthOf(rows), () => 5);

    const { report } = await run(rows, provider);

    expect(report.requests).toBe(4);
    expect(report.requestLatencyP50Ms).toBeGreaterThanOrEqual(4);
    expect(report.requestLatencyP95Ms).toBeGreaterThanOrEqual(report.requestLatencyP50Ms);
  });

  /**
   * Evidence-shaped fixture: 200 receiver groups, 30% over 400 classes, the
   * rest within one menu; concurrency 48. Run with RESIDUAL_BENCH=1.
   */
  it.skipIf(process.env.RESIDUAL_BENCH !== "1")("bench: evidence-shaped fixture wall time", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => groupRow(i, i % 10 < 3 ? 400 + (i % 60) : 10 + (i % 30)));
    const provider = new TimedProvider(truthOf(rows), workTime({ perQuestion: 10, perCriterion: 1 }));
    provider.lanes = 16;
    // The live 300 s request budget, scaled like the work: a 41-criteria block is ~50 ms here.
    provider.timeoutMs = 1500;

    const startedAt = Date.now();
    const { report } = await run(rows, provider, { concurrency: 48 });
    const wallMs = Date.now() - startedAt;

    console.log(
      `[bench] wall=${wallMs}ms requests=${provider.requests.length} maxQ=${Math.max(...provider.requests.map((r) => r.questions))} ` +
        `maxCriteria=${Math.max(...provider.requests.map((r) => r.criteria))} sitesEdged=${report.sitesEdged} answered=${report.answered} failed=${report.failedGroups} requeued=${report.requeuedGroups} p50=${report.requestLatencyP50Ms} p95=${report.requestLatencyP95Ms} peak=${report.peakInFlight}`,
    );
    expect(report.failedGroups).toBe(0);
  });
});
