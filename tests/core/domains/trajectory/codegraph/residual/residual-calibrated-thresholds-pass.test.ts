import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
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
  ResidualCalibratedThresholds,
  ResidualThresholdSource,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-thresholds.js";
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

  constructor(private readonly answer: Answer) {}

  version = async () => "fake@1";
  health = async (): Promise<{ ok: true }> => ({ ok: true });

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

/** One site on `receiver` in its own receiver group over `classes`, each class reaching `<Class>#save`. */
function siteOn(receiver: string, classes: string[]): ResidualCallSiteRow {
  const classTargets = classes.map((c) => [c, `${c}#save`] as [string, string]);
  return {
    siteKey: `site-${receiver}`,
    sourceRelPath: "app/a.rb",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 20,
    line: 5,
    column: 4,
    receiverText: receiver,
    member: "save",
    kind: "dynamic",
    candidates: classTargets.map(([, t]) => t),
    menuHash: `menu-${receiver}`,
    menuOverflow: false,
    receiverGroup: `group-${receiver}`,
    classTargets,
    language: "ruby",
  };
}

const THREE = ["Invoice", "Bill", "Estimate"];

/** An ungrouped TypeScript site on `receiver` whose menu is two `run` methods. */
function tsSite(receiver: string): ResidualCallSiteRow {
  return {
    siteKey: `ts-${receiver}`,
    sourceRelPath: "src/a.ts",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 20,
    line: 7,
    column: 2,
    receiverText: receiver,
    member: "run",
    kind: "dynamic",
    candidates: ["Job#run", "Task#run"],
    menuHash: `menu-${receiver}`,
    menuOverflow: false,
    language: "typescript",
  };
}

const fit = (threshold: number, n = 120) => ({ threshold, lowerBound: 0.94, n });

const calibrated = (over: Partial<ResidualCalibratedThresholds> = {}): ResidualCalibratedThresholds => ({
  block1: fit(0.5),
  fullMenu: fit(0.5),
  none: fit(0.5),
  pi: 0.2,
  ...over,
});

describe("ResidualResolutionPass — calibrated thresholds", () => {
  let rootDir: string;
  let store: ResidualVerdictStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-thresholds-pass-"));
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

  /** r1 picks Bill at 0.6, r2 answers none at 0.6, r3 picks Bill at 0.9 — all full-menu questions over three classes. */
  const mixedRun = () => {
    const graphDb = fakeGraphDb([siteOn("r1", THREE), siteOn("r2", THREE), siteOn("r3", THREE)]);
    const provider = new FakeProvider((q) => {
      if (q.receiverText === "r2") return { pick: null, p: 0.6 };
      return { pick: "Bill", p: q.receiverText === "r1" ? 0.6 : 0.9 };
    });
    return { graphDb, provider };
  };

  it("fits after asking from the run's own full-menu answers and builds the edges with the fit", async () => {
    const { graphDb, provider } = mixedRun();
    const source: ResidualThresholdSource = {
      stored: vi.fn(async () => undefined),
      calibrate: vi.fn(async () => calibrated()),
    };

    const report = await run(graphDb, provider, { thresholdSource: source });

    expect(source.stored).toHaveBeenCalledWith(
      "ruby",
      expect.objectContaining({ providerId: "kev", servedVersion: "fake@1" }),
    );
    expect(source.calibrate).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "ruby",
        mix: { answered: 3, noneAnswers: 1, menuSizeMix: { "2-4": 3 } },
      }),
    );
    expect(provider.questions()).toHaveLength(3);
    expect(
      graphDb.applied
        .at(-1)
        ?.map((e) => e.siteKey)
        .sort(),
    ).toEqual(["site-r1", "site-r3"]);
    expect(graphDb.external.at(-1)?.map((e) => e.siteKey)).toEqual(["site-r2"]);
    expect(report.thresholds?.ruby).toEqual({
      block1: { threshold: 0.7, source: "default" },
      fullMenu: { threshold: 0.5, source: "calibrated", lowerBound: 0.94, n: 120 },
      none: { threshold: 0.5, source: "calibrated", lowerBound: 0.94, n: 120 },
      pi: 0.2,
      reason: expect.stringContaining("block 1"),
    });
  });

  it("asks under a valid stored calibration and never calibrates again", async () => {
    const classes = ["Invoice", "Bill", "Estimate", "Payment", "Receipt"];
    const graphDb = fakeGraphDb([siteOn("invoice", classes)]);
    const provider = new FakeProvider((q) =>
      q.candidates.length === 1 ? { pick: "Invoice", p: 0.6 } : { pick: q.candidates[0] ?? null, p: 0.9 },
    );
    const source: ResidualThresholdSource = {
      stored: vi.fn(async () => calibrated()),
      calibrate: vi.fn(async () => calibrated()),
    };

    const report = await run(graphDb, provider, { menuLimit: 3, thresholdSource: source });

    expect(source.calibrate).not.toHaveBeenCalled();
    expect(provider.questions()).toHaveLength(1);
    expect(report.earlyAcceptedGroups).toBe(1);
    expect(graphDb.applied.at(-1)).toEqual([expect.objectContaining({ siteKey: "site-invoice", p: 0.6 })]);
    expect(report.thresholds?.ruby?.block1).toEqual({ threshold: 0.5, source: "calibrated", lowerBound: 0.94, n: 120 });
  });

  it("keeps the default for a stratum the calibration left null", async () => {
    const { graphDb, provider } = mixedRun();
    const source: ResidualThresholdSource = {
      stored: async () => calibrated({ fullMenu: null, block1: null }),
    };

    const report = await run(graphDb, provider, { thresholdSource: source, namePriorAcceptThreshold: 0.55 });

    expect(graphDb.applied.at(-1)?.map((e) => e.siteKey)).toEqual(["site-r3"]);
    expect(report.thresholds?.ruby).toMatchObject({
      block1: { threshold: 0.55, source: "default" },
      fullMenu: { threshold: 0.7, source: "default" },
      none: { threshold: 0.5, source: "calibrated" },
    });
  });

  it("falls back to the defaults with the reason when calibrating fails, and the pass still completes", async () => {
    const { graphDb, provider } = mixedRun();
    const source: ResidualThresholdSource = {
      stored: async () => undefined,
      calibrate: async () => Promise.reject(new Error("GPU busy")),
    };

    const report = await run(graphDb, provider, { thresholdSource: source });

    expect(report.outcome).toBe("completed");
    expect(graphDb.applied.at(-1)?.map((e) => e.siteKey)).toEqual(["site-r3"]);
    expect(report.thresholds?.ruby).toMatchObject({
      block1: { threshold: 0.7, source: "default" },
      fullMenu: { threshold: 0.7, source: "default" },
      none: { threshold: 0.8, source: "default" },
      pi: null,
      reason: expect.stringContaining("GPU busy"),
    });
  });

  it("does not apply a full-menu fit made after asking when the confirm stage judged mid picks by the default", async () => {
    const { graphDb, provider } = mixedRun();
    const source: ResidualThresholdSource = { stored: async () => undefined, calibrate: async () => calibrated() };

    const report = await run(graphDb, provider, { thresholdSource: source, confirmStage: true });

    expect(report.thresholds?.ruby).toMatchObject({
      fullMenu: { threshold: 0.7, source: "default" },
      none: { threshold: 0.5, source: "calibrated" },
      reason: expect.stringContaining("confirm"),
    });
  });

  it("never calibrates in a cacheOnly pass", async () => {
    const { graphDb, provider } = mixedRun();
    const source: ResidualThresholdSource = { stored: vi.fn(async () => undefined), calibrate: vi.fn() };

    const report = await run(graphDb, provider, { thresholdSource: source, mode: "cacheOnly" });

    expect(source.stored).toHaveBeenCalledWith(
      "ruby",
      expect.not.objectContaining({ servedVersion: expect.anything() }),
    );
    expect(source.calibrate).not.toHaveBeenCalled();
    expect(report.thresholds?.ruby?.fullMenu).toEqual({ threshold: 0.7, source: "default" });
  });

  it("reports the configured defaults without a threshold source", async () => {
    const { graphDb, provider } = mixedRun();

    const report = await run(graphDb, provider);

    expect(report.thresholds?.ruby).toEqual({
      block1: { threshold: 0.7, source: "default" },
      fullMenu: { threshold: 0.7, source: "default" },
      none: { threshold: 0.8, source: "default" },
      pi: null,
    });
  });
  it("judges a mixed run per language: calibrated ruby, default typescript", async () => {
    const classes = ["Invoice", "Bill", "Estimate", "Payment", "Receipt"];
    const graphDb = fakeGraphDb([siteOn("invoice", classes), tsSite("job")]);
    const provider = new FakeProvider((q) => {
      if (q.receiverText === "job") return { pick: "Job#run", p: 0.6 };
      return q.candidates.length === 1 ? { pick: "Invoice", p: 0.6 } : { pick: q.candidates[0] ?? null, p: 0.9 };
    });
    const source: ResidualThresholdSource = {
      stored: vi.fn(async (language: string) => (language === "ruby" ? calibrated() : undefined)),
    };

    const report = await run(graphDb, provider, { menuLimit: 3, thresholdSource: source });

    expect(source.stored).toHaveBeenCalledWith("ruby", expect.anything());
    expect(source.stored).toHaveBeenCalledWith("typescript", expect.anything());
    expect(report.earlyAcceptedGroups).toBe(1);
    expect(provider.questions()).toHaveLength(2);
    expect(graphDb.applied.at(-1)?.map((e) => e.siteKey)).toEqual(["site-invoice"]);
    expect(report.belowThreshold).toBe(1);
    expect(report.thresholds?.ruby?.block1).toMatchObject({ threshold: 0.5, source: "calibrated" });
    expect(report.thresholds?.typescript).toEqual({
      block1: { threshold: 0.7, source: "default" },
      fullMenu: { threshold: 0.7, source: "default" },
      none: { threshold: 0.8, source: "default" },
      pi: null,
    });
  });

  it("calibrates each language of a mixed run against its own answer mix", async () => {
    const graphDb = fakeGraphDb([siteOn("r1", THREE), siteOn("r2", THREE), siteOn("r3", THREE), tsSite("job")]);
    const provider = new FakeProvider((q) => {
      if (q.receiverText === "job") return { pick: "Job#run", p: 0.6 };
      if (q.receiverText === "r2") return { pick: null, p: 0.6 };
      return { pick: "Bill", p: q.receiverText === "r1" ? 0.6 : 0.9 };
    });
    const source: ResidualThresholdSource = {
      stored: async () => undefined,
      calibrate: vi.fn(async (r) =>
        r.language === "ruby" ? calibrated() : Promise.reject(new Error("too few static sample rows")),
      ),
    };

    const report = await run(graphDb, provider, { thresholdSource: source });

    expect(source.calibrate).toHaveBeenCalledWith(
      expect.objectContaining({ language: "ruby", mix: { answered: 3, noneAnswers: 1, menuSizeMix: { "2-4": 3 } } }),
    );
    expect(source.calibrate).toHaveBeenCalledWith(
      expect.objectContaining({ language: "typescript", mix: { answered: 0, noneAnswers: 0, menuSizeMix: {} } }),
    );
    expect(
      graphDb.applied
        .at(-1)
        ?.map((e) => e.siteKey)
        .sort(),
    ).toEqual(["site-r1", "site-r3"]);
    expect(report.thresholds?.ruby?.fullMenu).toMatchObject({ threshold: 0.5, source: "calibrated" });
    expect(report.thresholds?.typescript).toMatchObject({
      fullMenu: { threshold: 0.7, source: "default" },
      reason: expect.stringContaining("too few static sample rows"),
    });
  });
});
