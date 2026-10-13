/**
 * `preExisting` attribution for the pair/component families (bd
 * tea-rags-mcp-89k7k.1.19.2, spec D9): the diff run judges only diff-added
 * edges, so for stableDependencies and mainSequence `preExisting` means the
 * violation ALREADY held at the diff base through another edge — the
 * component pair already leaned the wrong way, or the component already sat
 * past the main-sequence threshold. A missing fact is never "already held".
 */
import { describe, expect, it } from "vitest";

import { baseEdgesOf, catalogOf, overlayOf, runWith, type ComponentFact } from "../__helpers__/diff-run-fixtures.js";
import { DiffDetectorRun } from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import {
  componentPairViolatedAtBase,
  pastThresholdBefore,
} from "../../../../../../src/core/api/internal/ops/diff-families/pre-existing.js";
import type { DiffDetectorFinding } from "../../../../../../src/core/contracts/types/diff-detector-finding.js";

/** `a` leans on the markedly-less-stable `b` (0.9 - 0.2 >= the fixture band 0.3). */
const SDP_COMPONENTS = new Map<string, Omit<ComponentFact, "connectionCount">>([
  ["a/x.ts", { name: "a", instability: 0.2, distanceFromMainSequence: 0 }],
  ["a/z.ts", { name: "a", instability: 0.2, distanceFromMainSequence: 0 }],
  ["b/y.ts", { name: "b", instability: 0.9, distanceFromMainSequence: 0 }],
  ["b/w.ts", { name: "b", instability: 0.9, distanceFromMainSequence: 0 }],
]);

function findingsOf(findings: readonly DiffDetectorFinding[], detector: DiffDetectorFinding["detector"]) {
  return findings.filter((finding) => finding.detector === detector);
}

describe("stableDependencies preExisting", () => {
  it("stamps preExisting when the base already held the component pair through another edge", () => {
    const result = runWith(
      { catalog: catalogOf(SDP_COMPONENTS), baseEdges: baseEdgesOf({ "a/x.ts": ["b/y.ts"], "a/z.ts": [] }) },
      ["a/x.ts", "a/z.ts"],
      [
        ["a/x.ts", "b/y.ts"],
        ["a/z.ts", "b/w.ts"],
      ],
    );
    const sdp = findingsOf(result.findings, "stableDependencies");
    expect(sdp).toHaveLength(1);
    expect(sdp[0]?.endpoints).toMatchObject({ sourceRelPath: "a/z.ts", targetRelPath: "b/w.ts" });
    expect(sdp[0]?.preExisting).toBe(true);
  });

  it("leaves preExisting absent when the base held no edge of the pair", () => {
    const result = runWith(
      { catalog: catalogOf(SDP_COMPONENTS), baseEdges: baseEdgesOf({ "a/z.ts": [] }) },
      ["a/z.ts"],
      [["a/z.ts", "b/w.ts"]],
    );
    const sdp = findingsOf(result.findings, "stableDependencies");
    expect(sdp).toHaveLength(1);
    expect(sdp[0]).not.toHaveProperty("preExisting");
  });

  it("leaves preExisting absent when the base reader cannot answer for any source file of the pair", () => {
    const result = runWith(
      { catalog: catalogOf(SDP_COMPONENTS), baseEdges: baseEdgesOf({}) },
      ["a/x.ts", "a/z.ts"],
      [["a/z.ts", "b/w.ts"]],
    );
    const sdp = findingsOf(result.findings, "stableDependencies");
    expect(sdp).toHaveLength(1);
    expect(sdp[0]).not.toHaveProperty("preExisting");
  });
});

describe("mainSequence preExisting", () => {
  /** Ca = Ce = 10 and one new edge: I 0.5 -> 11/21, so D moves by ~0.024 with abstractness held. */
  function runMainSequence(distanceBefore: number, mainSequenceDistanceThreshold?: number) {
    const components = new Map<string, Omit<ComponentFact, "connectionCount">>([
      [
        "src/app/a.ts",
        {
          name: "app",
          instability: 0.5,
          distanceFromMainSequence: distanceBefore,
          afferentCount: 10,
          efferentCount: 10,
        },
      ],
      ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0 }],
    ]);
    const changedFiles = ["src/app/a.ts"];
    const run = new DiffDetectorRun({
      catalog: catalogOf(components),
      ...(mainSequenceDistanceThreshold !== undefined ? { mainSequenceDistanceThreshold } : {}),
    });
    return findingsOf(
      run.run({ changedFiles }, overlayOf([["src/app/a.ts", "src/lib/b.ts"]], changedFiles)).findings,
      "mainSequence",
    );
  }

  it("stamps preExisting when the component already sat past the threshold before the diff", () => {
    const findings = runMainSequence(0.31, 0.2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.preExisting).toBe(true);
  });

  it("leaves preExisting absent on a threshold flap — the diff is what carried D across", () => {
    const findings = runMainSequence(0.19, 0.2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toMatchObject({ distanceBefore: 0.19, distanceAfter: 0.214 });
    expect(findings[0]).not.toHaveProperty("preExisting");
  });

  it("leaves preExisting absent when the threshold is not served — a missing fact is never already held", () => {
    const findings = runMainSequence(0.31);
    expect(findings).toHaveLength(1);
    expect(findings[0]).not.toHaveProperty("preExisting");
  });
});

describe("pre-existing helpers", () => {
  const componentOf = (relPath: string) => relPath.split("/")[0];
  const sourceFilesOf = (component: string) => (component === "a" ? ["a/x.ts", "a/z.ts"] : []);
  const pair = { sourceComponent: "a", targetComponent: "b" };

  it("componentPairViolatedAtBase answers false without a base reader", () => {
    expect(componentPairViolatedAtBase(pair, undefined, componentOf, sourceFilesOf)).toBe(false);
  });

  it("componentPairViolatedAtBase reads every answered source file of the pair's source component", () => {
    expect(componentPairViolatedAtBase(pair, baseEdgesOf({ "a/z.ts": ["b/y.ts"] }), componentOf, sourceFilesOf)).toBe(
      true,
    );
    expect(componentPairViolatedAtBase(pair, baseEdgesOf({ "a/z.ts": ["c/q.ts"] }), componentOf, sourceFilesOf)).toBe(
      false,
    );
  });

  it("pastThresholdBefore is strict: a distance at the threshold is not past it", () => {
    expect(pastThresholdBefore(0.31, 0.2)).toBe(true);
    expect(pastThresholdBefore(0.2, 0.2)).toBe(false);
    expect(pastThresholdBefore(0.19, 0.2)).toBe(false);
  });
});
