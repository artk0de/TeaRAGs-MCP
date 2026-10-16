import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { ResidualVerdictStore } from "../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import { ResidualResolutionOps } from "../../../../../src/core/api/internal/ops/residual-resolution-ops.js";
import type { ModelEdgeRow, ResidualCallSiteRow } from "../../../../../src/core/contracts/types/codegraph-residual.js";
import type {
  ResidualModelProvider,
  ResidualQuestionGroup,
} from "../../../../../src/core/domains/trajectory/codegraph/residual/types.js";
import type { ProgressUpdate } from "../../../../../src/core/types.js";

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
};

const CONFIG = {
  kevUrls: ["http://gpu:8090"],
  kevThreshold: 0.7,
  concurrency: 4,
  menuLimit: 40,
  minMenu: 2,
  noneThreshold: 0.8,
  retentionDays: 180,
};

function answeringProvider(groups: ResidualQuestionGroup[]): ResidualModelProvider {
  return {
    id: "kev",
    threshold: 0.7,
    version: async () => "fake@1",
    health: async () => ({ ok: true }),
    resolveGroup: async (group) => {
      groups.push(group);
      return group.questions.map((q) => ({
        siteKey: q.siteKey,
        pick: "Firm#users",
        p: 0.9,
        probabilities: { "Firm#users": 0.9 },
        questionPayload: "{}",
      }));
    },
  };
}

describe("ResidualResolutionOps", () => {
  let rootDir: string;
  let projectRoot: string;
  let applied: ModelEdgeRow[][];
  let acquireWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-ops-root-"));
    projectRoot = mkdtempSync(join(tmpdir(), "residual-ops-project-"));
    mkdirSync(join(projectRoot, "app"));
    writeFileSync(join(projectRoot, "app/sync.rb"), "class Sync\n  def run(firm)\n    firm.users\n  end\nend\n");
    applied = [];
    acquireWrite = vi.fn(async () => ({
      graphDb: {
        readResidualCallSites: async () => [ROW],
        applyModelEdges: async (_model: string, edges: ModelEdgeRow[]) => {
          applied.push(edges);
          return { stored: edges.length, changed: true };
        },
        applyModelExternalSites: async () => undefined,
        markDerivedStale: async () => undefined,
        computeAndPersistCyclesAndSignals: async () => undefined,
      },
    }));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const request = () => ({
    logicalName: "code_test",
    physicalCollectionName: PHYSICAL,
    projectRoot,
  });

  it("asks the model about the collection's residual sites with the method's source lines and applies its pick", async () => {
    const groups: ResidualQuestionGroup[] = [];
    const progress: ProgressUpdate[] = [];
    const ops = new ResidualResolutionOps({
      rootDir,
      codegraphPool: { acquireWrite } as never,
      config: CONFIG,
      createProvider: () => answeringProvider(groups),
    });

    const report = await ops.resolve({ ...request(), model: "kev", onProgress: (p) => progress.push(p) });

    expect(report).toMatchObject({ outcome: "completed", mode: "ask", sites: 1, asked: 1, edgesApplied: 1 });
    expect(acquireWrite).toHaveBeenCalledWith(PHYSICAL);
    expect(groups[0].methodSource).toBe("  def run(firm)\n    firm.users\n  end");
    expect(applied[0].map((e) => e.targetSymbolId)).toEqual(["Firm#users"]);
    expect(progress.at(-1)).toMatchObject({ phase: "resolving-residual" });
    expect(existsSync(ResidualVerdictStore.pathFor(rootDir, "code_test"))).toBe(true);
  });

  it("names the threshold each model's edges are applied at", () => {
    const ops = new ResidualResolutionOps({ rootDir, codegraphPool: { acquireWrite } as never, config: CONFIG });

    expect(ops.thresholds).toEqual({ kev: 0.7 });
  });

  it("turns an unknown model into a skipped report instead of throwing", async () => {
    const ops = new ResidualResolutionOps({ rootDir, codegraphPool: { acquireWrite } as never, config: CONFIG });

    const report = await ops.resolve({ ...request(), model: "gpt-9" });

    expect(report).toMatchObject({ outcome: "skipped", mode: "ask", sites: 0, edgesApplied: 0 });
    expect(report.reason).toMatch(/residualModel/);
  });

  describe("GPU session", () => {
    const leasedProvider = (events: string[]): ResidualModelProvider => ({
      ...answeringProvider([]),
      acquire: async () => {
        events.push("acquire");
        return {
          release: async () => {
            events.push("release");
          },
        };
      },
    });

    it("leases the provider for an ask pass with uncached sites, and not again once every site is cached", async () => {
      const events: string[] = [];
      const ops = new ResidualResolutionOps({
        rootDir,
        codegraphPool: { acquireWrite } as never,
        config: CONFIG,
        createProvider: () => leasedProvider(events),
      });

      await ops.resolve({ ...request(), model: "kev" });
      await ops.resolve({ ...request(), model: "kev" });
      await ops.resolveAfterIndex(request());

      expect(events).toEqual(["acquire", "release"]);
    });

    it("asks the session broker configured in codegraph.residual, ending skipped when it is unreachable", async () => {
      const ops = new ResidualResolutionOps({
        rootDir,
        codegraphPool: { acquireWrite } as never,
        config: { ...CONFIG, kevUrls: undefined, kevSessionUrl: "http://127.0.0.1:1", kevSessionToken: "s3cret" },
      });

      const report = await ops.resolve({ ...request(), model: "kev" });

      expect(report).toMatchObject({ outcome: "skipped", asked: 0 });
      expect(report.reason).toMatch(/^provider kev unavailable: gpu-session-unavailable: GET \/v1\/state/);
      expect(report.reason).not.toContain("s3cret");
    });
  });

  describe("resolveAfterIndex", () => {
    it("does nothing when no model is asked and the project has no verdicts", async () => {
      const ops = new ResidualResolutionOps({ rootDir, codegraphPool: { acquireWrite } as never, config: CONFIG });

      await expect(ops.resolveAfterIndex(request())).resolves.toBeUndefined();
      expect(acquireWrite).not.toHaveBeenCalled();
      expect(existsSync(ResidualVerdictStore.pathFor(rootDir, "code_test"))).toBe(false);
    });

    it("asks the named model", async () => {
      const groups: ResidualQuestionGroup[] = [];
      const ops = new ResidualResolutionOps({
        rootDir,
        codegraphPool: { acquireWrite } as never,
        config: CONFIG,
        createProvider: () => answeringProvider(groups),
      });

      const report = await ops.resolveAfterIndex({ ...request(), model: "kev" });

      expect(report).toMatchObject({ outcome: "completed", mode: "ask", edgesApplied: 1 });
      expect(groups).toHaveLength(1);
    });

    it("re-applies the stored verdicts without a model call when the project has verdicts, even with no Kev URL", async () => {
      const groups: ResidualQuestionGroup[] = [];
      await new ResidualResolutionOps({
        rootDir,
        codegraphPool: { acquireWrite } as never,
        config: CONFIG,
        createProvider: () => answeringProvider(groups),
      }).resolve({ ...request(), model: "kev" });
      applied = [];
      const { kevUrls: _urls, ...configWithoutKev } = CONFIG;
      const ops = new ResidualResolutionOps({
        rootDir,
        codegraphPool: { acquireWrite } as never,
        config: configWithoutKev,
      });

      const report = await ops.resolveAfterIndex(request());

      expect(report).toMatchObject({
        outcome: "completed",
        mode: "cacheOnly",
        cacheHits: 1,
        asked: 0,
        edgesApplied: 1,
      });
      expect(applied[0].map((e) => e.targetSymbolId)).toEqual(["Firm#users"]);
      expect(groups).toHaveLength(1);
    });
  });
});
