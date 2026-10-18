import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import type { GraphDbClient } from "../../../../../../src/core/contracts/types/codegraph-storage.js";
import { GraphClassTieReader } from "../../../../../../src/core/domains/trajectory/codegraph/residual/interface-fanout.js";
import { ResidualResolutionPass } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.js";
import { StoredResidualThresholds } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-thresholds.js";
import {
  reapplyTreeModelEdges,
  type WorkingTreeGraphResidualInput,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-model-edges.js";

describe("reapplyTreeModelEdges — pass input", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "tree-model-edges-input-"));
    await (await ResidualVerdictStore.open(rootDir, "code_test")).close();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const residual = (over: Partial<WorkingTreeGraphResidualInput> = {}): WorkingTreeGraphResidualInput => ({
    verdictRootDir: rootDir,
    logicalName: "code_test",
    model: "kev",
    threshold: 0.7,
    menuLimit: 40,
    minMenu: 1,
    noneThreshold: 0.8,
    ...over,
  });

  const passInput = async (input: WorkingTreeGraphResidualInput) => {
    const run = vi.spyOn(ResidualResolutionPass.prototype, "run").mockResolvedValue({ edgesApplied: 0 } as never);
    await reapplyTreeModelEdges({} as GraphDbClient, input, "/tree");
    return run.mock.calls[0]?.[0];
  };

  it("passes the index run's name-prior threshold, confirm stage, fan-out floor and tie reader", async () => {
    const input = await passInput(residual({ namePriorAcceptThreshold: 0.55, confirmStage: true, fanoutFloor: 0.2 }));

    expect(input).toMatchObject({ namePriorAcceptThreshold: 0.55, confirmStage: true, fanoutFloor: 0.2 });
    expect(input?.classTies).toBeInstanceOf(GraphClassTieReader);
  });

  it("reads the stored calibration but never calibrates", async () => {
    const input = await passInput(residual());

    expect(input?.thresholdSource).toBeInstanceOf(StoredResidualThresholds);
    expect(input?.thresholdSource?.calibrate).toBeUndefined();
  });

  it("applies no calibration when the index run has auto-calibration off", async () => {
    const input = await passInput(residual({ autoCalibrate: false }));

    expect(input?.thresholdSource).toBeUndefined();
  });
});
