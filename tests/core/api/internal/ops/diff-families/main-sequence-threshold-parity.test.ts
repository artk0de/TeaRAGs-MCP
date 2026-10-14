/**
 * Main-sequence threshold parity (bd tea-rags-mcp-x6y75): the whole-repo
 * detector names a component only when its distance from the main sequence
 * is past the served adaptive `distanceThreshold`. A diff rise that leaves the
 * component short of that line is a move the whole-repo report would never
 * name, so the diff family does not either — it counts it on the detector row
 * (`excludedBelowThresholdCount`). A rise that crosses into violation
 * territory, or grows inside it, stays a finding; with no threshold served
 * (unmeasured) every rise past the flap tolerance is a finding, as before.
 */
import { describe, expect, it } from "vitest";

import { baseEdgesOf, catalogOf, graphOf, overlayOf, type ComponentFact } from "../__helpers__/diff-run-fixtures.js";
import {
  DiffDetectorRun,
  type DiffDetectorFindings,
} from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../../../src/core/primitives/graph/index.js";

const SOURCE = "src/app/a.ts";
const TARGET = "src/lib/l.ts";
const SERVED_THRESHOLD = 0.5;

/** Ca 8, Ce 1: one newly efferent file lifts I 1/9 -> 2/10, so D rises by ~0.089 at held abstractness. */
function appAt(distanceFromMainSequence: number): ComponentFact {
  return {
    name: "src/app",
    instability: 1 / 9,
    distanceFromMainSequence,
    connectionCount: 9,
    afferentCount: 8,
    efferentCount: 1,
  };
}

const LIB: ComponentFact = { name: "src/lib", instability: 0.2, distanceFromMainSequence: 0, connectionCount: 20 };

function diffRun(distanceBefore: number, mainSequenceDistanceThreshold: number | undefined): DiffDetectorFindings {
  return new DiffDetectorRun({
    graph: graphOf([]),
    catalog: catalogOf(
      new Map<string, ComponentFact>([
        [SOURCE, appAt(distanceBefore)],
        [TARGET, LIB],
      ]),
    ),
    baseEdges: baseEdgesOf({ [SOURCE]: [] }),
    ...(mainSequenceDistanceThreshold !== undefined ? { mainSequenceDistanceThreshold } : {}),
  }).run({ changedFiles: [SOURCE] }, overlayOf([[SOURCE, TARGET]], [SOURCE]));
}

function mainSequence(result: DiffDetectorFindings) {
  return {
    findings: result.findings.filter((finding) => finding.detector === "mainSequence"),
    row: result.detectors.find((row) => row.detector === "mainSequence"),
  };
}

/** Whether the whole-repo detector (majority method, as served on this tree) names a component at `distance`. */
function wholeRepoNames(distance: number): boolean {
  return resolveMajorityFlooredOtsuThreshold([], { majority: SERVED_THRESHOLD, minPopulation: 8 }).admits(distance);
}

describe("mainSequence diff rises judged against the served whole-repo threshold (bd tea-rags-mcp-x6y75)", () => {
  it("a rise that stays below the threshold is no finding — counted on the detector row", () => {
    const { findings, row } = mainSequence(diffRun(0, SERVED_THRESHOLD));
    expect(findings).toHaveLength(0);
    expect(row).toMatchObject({ findingCount: 0, excludedBelowThresholdCount: 1 });
  });

  it("a rise that crosses the threshold is a finding", () => {
    const { findings, row } = mainSequence(diffRun(0.45, SERVED_THRESHOLD));
    expect(findings).toHaveLength(1);
    expect(findings[0]).not.toHaveProperty("preExisting");
    expect(row).not.toHaveProperty("excludedBelowThresholdCount");
  });

  it("a rise that grows inside violation territory is a finding", () => {
    const { findings } = mainSequence(diffRun(0.6, SERVED_THRESHOLD));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ preExisting: true });
  });

  it("with no threshold served, a rise past the flap tolerance stays a finding", () => {
    const { findings, row } = mainSequence(diffRun(0, undefined));
    expect(findings).toHaveLength(1);
    expect(row).not.toHaveProperty("excludedBelowThresholdCount");
  });

  for (const distanceBefore of [0, 0.3, 0.45, 0.6]) {
    it(`D before ${distanceBefore}: the diff reports the rise exactly when the whole-repo detector would name D after`, () => {
      const unfiltered = mainSequence(diffRun(distanceBefore, undefined)).findings;
      expect(unfiltered).toHaveLength(1);
      const { distanceAfter } = unfiltered[0].evidence;
      const { findings } = mainSequence(diffRun(distanceBefore, SERVED_THRESHOLD));
      expect(findings.length > 0).toBe(wholeRepoNames(distanceAfter));
    });
  }
});
