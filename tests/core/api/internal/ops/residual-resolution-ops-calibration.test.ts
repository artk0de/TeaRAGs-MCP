import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { ResidualResolutionOps } from "../../../../../src/core/api/internal/ops/residual-resolution-ops.js";
import type {
  ModelEdgeRow,
  ResidualCalibrationRow,
  ResidualCallSiteRow,
  StaticSiteSampleRow,
} from "../../../../../src/core/contracts/types/codegraph-residual.js";
import {
  residualQuestionFold,
  ResidualResolutionPass,
} from "../../../../../src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.js";
import type { ResidualModelProvider } from "../../../../../src/core/domains/trajectory/codegraph/residual/types.js";

const PHYSICAL = fixturePhysicalCollectionName("code_test_v1");

const ROW: ResidualCallSiteRow = {
  siteKey: "s1",
  sourceRelPath: "app/sync.rb",
  methodSymbolId: "Sync#run",
  methodStartLine: 2,
  methodEndLine: 4,
  line: 3,
  column: 2,
  receiverText: "firm",
  member: "users",
  kind: "ambiguous",
  candidates: ["Firm#users", "Client#users"],
  menuHash: "m1",
  menuOverflow: false,
  language: "ruby",
};

/** `count` resolved sample sites of `language`, enough for a calibration at 60. */
const sampleRows = (count: number, language = "ruby"): StaticSiteSampleRow[] =>
  Array.from({ length: count }, (_, i) => ({
    siteKey: `sample-${language}-${i}`,
    sourceRelPath: "app/sync.rb",
    language,
    methodSymbolId: "Sync#run",
    methodStartLine: 2,
    methodEndLine: 4,
    line: 3,
    column: 2,
    receiverText: "firm",
    receiverKind: "localVar",
    member: "users",
    outcome: "resolved",
    targetSymbolId: "Firm#users",
    reason: null,
    owners: 2,
    candidates: ["Client#users", "Firm#users"],
    menuOverflow: false,
    priority: i / 1_000,
  }));

const CONFIG = {
  kevUrls: ["http://gpu:8090"],
  kevThreshold: 0.7,
  concurrency: 4,
  menuLimit: 40,
  minMenu: 2,
  noneThreshold: 0.8,
  retentionDays: 180,
};

const FOLD = residualQuestionFold({ originContext: false });

const calibrationRow = (stratum: ResidualCalibrationRow["stratum"], model = "kev@fake@1"): ResidualCalibrationRow => ({
  language: "ruby",
  stratum,
  threshold: 0.5,
  lowerBound: 0.94,
  n: 120,
  pi: 0.2,
  noneRates: { residual: 0.3, onMenu: 0.05, external: 0.8 },
  model,
  templateHash: FOLD,
  graphFingerprint: "g1",
  createdAt: 1,
});

function provider(events: string[]): ResidualModelProvider {
  return {
    id: "kev",
    threshold: 0.7,
    version: async () => "fake@1",
    health: async () => ({ ok: true }),
    acquire: async () => {
      events.push("acquire");
      return { release: async () => void events.push("release") };
    },
    resolveGroup: async (group) =>
      group.questions.map((q) => ({
        siteKey: q.siteKey,
        pick: "Firm#users",
        p: 0.6,
        probabilities: { "Firm#users": 0.6 },
        questionPayload: "{}",
      })),
  };
}

describe("ResidualResolutionOps — auto-calibration", () => {
  let rootDir: string;
  let projectRoot: string;
  let applied: ModelEdgeRow[][];
  let stored: ResidualCalibrationRow[];
  let graphDb: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-ops-cal-root-"));
    projectRoot = mkdtempSync(join(tmpdir(), "residual-ops-cal-project-"));
    mkdirSync(join(projectRoot, "app"));
    writeFileSync(join(projectRoot, "app/sync.rb"), "class Sync\n  def run(firm)\n    firm.users\n  end\nend\n");
    applied = [];
    stored = [];
    graphDb = {
      readResidualCallSites: vi.fn(async () => [ROW]),
      applyModelEdges: vi.fn(async (_model: string, edges: ModelEdgeRow[]) => {
        applied.push(edges);
        return { stored: edges.length, changed: true };
      }),
      applyModelExternalSites: vi.fn(async () => undefined),
      markDerivedStale: vi.fn(async () => undefined),
      computeAndPersistCyclesAndSignals: vi.fn(async () => undefined),
      readResidualCalibration: vi.fn(async () => stored),
      writeResidualCalibration: vi.fn(async () => undefined),
      readStaticSiteSample: vi.fn(async () => []),
    };
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const ops = (events: string[], config: Record<string, unknown> = {}) =>
    new ResidualResolutionOps({
      rootDir,
      codegraphPool: { acquireWrite: async () => ({ graphDb }) } as never,
      config: { ...CONFIG, ...config },
      createProvider: () => provider(events),
    });
  const request = () => ({ logicalName: "code_test", physicalCollectionName: PHYSICAL, projectRoot, model: "kev" });

  it("reuses a calibration stored under the served model and fold without asking for a new one", async () => {
    stored = [calibrationRow("block1"), calibrationRow("fullMenu"), calibrationRow("none")];

    const report = await ops([]).resolve(request());

    expect(graphDb.readResidualCalibration).toHaveBeenCalledWith("ruby");
    expect(graphDb.readStaticSiteSample).not.toHaveBeenCalled();
    expect(graphDb.writeResidualCalibration).not.toHaveBeenCalled();
    expect(applied.at(-1)).toEqual([expect.objectContaining({ siteKey: "s1", p: 0.6 })]);
    expect(report.thresholds?.ruby?.fullMenu).toEqual({
      threshold: 0.5,
      source: "calibrated",
      lowerBound: 0.94,
      n: 120,
    });
  });

  it("recalibrates when the served model changed, leasing the GPU once, and stores the result", async () => {
    stored = [calibrationRow("block1", "kev@fake@0"), calibrationRow("fullMenu", "kev@fake@0")];
    graphDb.readStaticSiteSample.mockResolvedValue(sampleRows(60));
    const events: string[] = [];

    const report = await ops(events).resolve(request());

    expect(graphDb.readStaticSiteSample).toHaveBeenCalledOnce();
    expect(graphDb.writeResidualCalibration).toHaveBeenCalledWith(
      "ruby",
      expect.arrayContaining([
        expect.objectContaining({ stratum: "fullMenu", model: "kev@fake@1", templateHash: FOLD }),
      ]),
    );
    expect(events).toEqual(["acquire", "release"]);
    expect(report.thresholds?.ruby?.fullMenu).toEqual({ threshold: 0.7, source: "default" });
  });

  it("keeps the defaults with the reason when calibrating fails, the pass completing all the same", async () => {
    graphDb.readStaticSiteSample.mockRejectedValue(new Error("sample unreadable"));

    const report = await ops([]).resolve(request());

    expect(report.outcome).toBe("completed");
    expect(report.thresholds?.ruby).toMatchObject({
      fullMenu: { threshold: 0.7, source: "default" },
      reason: expect.stringContaining("sample unreadable"),
    });
  });

  it("skips calibrating a language whose static sample is too small, with the reason", async () => {
    graphDb.readStaticSiteSample.mockResolvedValue(sampleRows(60, "typescript"));

    const report = await ops([]).resolve(request());

    expect(graphDb.writeResidualCalibration).not.toHaveBeenCalled();
    expect(report.thresholds?.ruby).toMatchObject({
      fullMenu: { threshold: 0.7, source: "default" },
      reason: expect.stringContaining("too few static sample rows for ruby: 0 < 60"),
    });
  });

  it("re-applies cached verdicts under the stored calibration without ever calibrating", async () => {
    const run = vi.spyOn(ResidualResolutionPass.prototype, "run");

    await ops([]).resolve({ ...request(), mode: "cacheOnly" });

    const source = run.mock.calls[0]?.[0].thresholdSource;
    expect(source).toBeDefined();
    expect(source?.calibrate).toBeUndefined();
    run.mockRestore();
  });

  it("hands the pass no threshold source when CODEGRAPH_RESIDUAL_AUTO_CALIBRATE is off", async () => {
    const run = vi.spyOn(ResidualResolutionPass.prototype, "run");

    await ops([], { autoCalibrate: false }).resolve(request());

    expect(run.mock.calls[0]?.[0].thresholdSource).toBeUndefined();
    expect(graphDb.readResidualCalibration).not.toHaveBeenCalled();
    run.mockRestore();
  });
});
