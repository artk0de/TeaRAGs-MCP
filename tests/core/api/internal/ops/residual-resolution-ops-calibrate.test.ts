import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { ResidualResolutionOps } from "../../../../../src/core/api/internal/ops/residual-resolution-ops.js";
import type { StaticSiteSampleRow } from "../../../../../src/core/contracts/types/codegraph-residual.js";
import type {
  ResidualModelProvider,
  ResidualQuestionGroup,
} from "../../../../../src/core/domains/trajectory/codegraph/residual/types.js";

const PHYSICAL = fixturePhysicalCollectionName("code_test_v1");

const SAMPLE: StaticSiteSampleRow = {
  siteKey: "s1",
  sourceRelPath: "app/sync.rb",
  language: "ruby",
  methodSymbolId: "Sync#run",
  methodStartLine: 2,
  methodEndLine: 4,
  line: 3,
  column: 4,
  receiverText: "firm",
  receiverKind: "localVar",
  member: "users",
  outcome: "resolved",
  targetSymbolId: "Firm#users",
  reason: null,
  owners: 2,
  candidates: ["Client#users", "Firm#users"],
  menuOverflow: false,
  priority: 0.01,
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
        pick: "Firm",
        p: 0.9,
        probabilities: { Firm: 0.9 },
        questionPayload: "{}",
      }));
    },
  };
}

describe("ResidualResolutionOps#calibrate", () => {
  let rootDir: string;
  let projectRoot: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-cal-root-"));
    projectRoot = mkdtempSync(join(tmpdir(), "residual-cal-project-"));
    mkdirSync(join(projectRoot, "app"));
    writeFileSync(join(projectRoot, "app/sync.rb"), "class Sync\n  def run(firm)\n    firm.users\n  end\nend\n");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("asks the sample's questions over the working-tree method source and returns the scored records", async () => {
    const groups: ResidualQuestionGroup[] = [];
    const acquireWrite = vi.fn(async () => ({ graphDb: { readStaticSiteSample: async () => [SAMPLE] } }));
    const ops = new ResidualResolutionOps({
      rootDir,
      codegraphPool: { acquireWrite } as never,
      config: CONFIG,
      createProvider: () => answeringProvider(groups),
    });

    const report = await ops.calibrate({
      logicalName: "code_test",
      physicalCollectionName: PHYSICAL,
      projectRoot,
      model: "kev",
    });

    expect(report.outcome).toBe("completed");
    expect(report.strata).toEqual({ fullMenu: 1, block1: 1, external: 0 });
    expect(report.records).toEqual([
      { stratum: "fullMenu", p: 0.9, top: "class", correct: true, menuSize: 2 },
      { stratum: "block1", p: 0.9, top: "class", correct: true, menuSize: 1 },
    ]);
    expect(groups[0].methodSource).toContain("firm.users");
    expect(acquireWrite).toHaveBeenCalledWith(PHYSICAL);
  });

  it("a failure to open the graph ends the run skipped", async () => {
    const ops = new ResidualResolutionOps({
      rootDir,
      codegraphPool: { acquireWrite: async () => Promise.reject(new Error("locked")) },
      config: CONFIG,
      createProvider: () => answeringProvider([]),
    });

    const report = await ops.calibrate({
      logicalName: "code_test",
      physicalCollectionName: PHYSICAL,
      projectRoot,
      model: "kev",
    });

    expect(report).toMatchObject({ outcome: "skipped", reason: "locked", records: [] });
  });
});
