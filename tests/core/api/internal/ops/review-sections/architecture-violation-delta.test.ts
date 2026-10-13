/**
 * The keyed delta of a base and an overlaid violation set, and the collapse of
 * the diff run's findings it drives (bd tea-rags-mcp-89k7k.1.7, owner decision
 * 2026-10-13 "collapse persisting").
 */
import { describe, expect, it } from "vitest";

import {
  collapsePersistingFindings,
  measureArchitectureViolationDelta,
  resolvedChangeSubjects,
} from "../../../../../../src/core/api/internal/ops/review-sections/architecture-violation-delta.js";
import type {
  ArchitectureViolation,
  FacadeLeakArchitectureViolation,
  StableDependencyArchitectureViolation,
} from "../../../../../../src/core/contracts/types/architecture-report.js";
import type { DiffDetectorFinding } from "../../../../../../src/core/contracts/types/diff-detector-finding.js";

function sdp(source: string, target: string): StableDependencyArchitectureViolation {
  return {
    detector: "stableDependencies",
    sourceComponent: source,
    targetComponent: target,
    evidence: {
      sourceInstability: 0.2,
      targetInstability: 0.8,
      instabilityDelta: 0.6,
      sourceAfferentCount: 4,
      sourceEfferentCount: 1,
      targetAfferentCount: 1,
      targetEfferentCount: 4,
      callWeight: 1,
      directoryRelation: "disjoint",
      fileEdgeCount: 1,
      fileEdges: [{ sourceRelPath: `${source}/a.ts`, targetRelPath: `${target}/b.ts`, callWeight: 1 }],
    },
  };
}

function leak(source: string, target: string): FacadeLeakArchitectureViolation {
  return {
    detector: "leakingAbstraction",
    kind: "internal-reach",
    sourceRelPath: source,
    targetRelPath: target,
    evidence: {
      moduleDir: "src/lib",
      facadeRelPath: "src/lib/index.ts",
      adoption: 0.9,
      facadeImporterCount: 9,
      deepImporterCount: 1,
      callWeight: 1,
    },
  };
}

function sdpFinding(source: string, target: string, preExisting = false): DiffDetectorFinding {
  return {
    subject: `${source} → ${target}`,
    detail: "d",
    detector: "stableDependencies",
    endpoints: {
      kind: "componentEdge",
      sourceComponent: source,
      targetComponent: target,
      sourceRelPath: `${source}/x.ts`,
      targetRelPath: `${target}/y.ts`,
    },
    evidence: { sourceInstability: 0.1, targetInstability: 0.9 },
    ...(preExisting ? { preExisting: true as const } : {}),
  };
}

function leakFinding(source: string, target: string, preExisting = true): DiffDetectorFinding {
  return {
    subject: `${source} → ${target}`,
    detail: "d",
    detector: "leakingAbstraction",
    endpoints: { kind: "fileEdge", sourceRelPath: source, targetRelPath: target },
    evidence: { facadeRelPath: "src/lib/index.ts" },
    ...(preExisting ? { preExisting: true as const } : {}),
  };
}

function mergeFinding(): DiffDetectorFinding {
  return {
    subject: "src/core/api ~ src/mcp/tools",
    detail: "d",
    detector: "splitCandidates",
    endpoints: { kind: "componentPair", componentA: "src/core/api", componentB: "src/mcp/tools" },
    evidence: {
      strength: 0.7,
      sideA: { changedFileCount: 1, changedFiles: ["src/core/api/a.ts"] },
      sideB: { changedFileCount: 0, changedFiles: [] },
    },
  };
}

function cycleFinding(source: string, target: string, flags: { preExisting?: boolean; remedy?: boolean } = {}) {
  const finding: DiffDetectorFinding = {
    subject: `${source} → ${target}`,
    detail: "d",
    detector: "cycles",
    endpoints: { kind: "fileEdge", sourceRelPath: source, targetRelPath: target },
    evidence: { path: [source, target, source] },
    ...(flags.preExisting ? { preExisting: true as const } : {}),
    ...(flags.remedy
      ? {
          remedy: {
            kind: "retargetImport" as const,
            sourceRelPath: source,
            fromRelPath: target,
            toRelPath: "src/lib/index.ts",
            importedNames: ["X"],
          },
        }
      : {}),
  };
  return finding;
}

describe("measureArchitectureViolationDelta", () => {
  it("splits keys into introduced, resolved and persisting — evidence never decides identity", () => {
    const base: ArchitectureViolation[] = [sdp("src/a", "src/b"), sdp("src/c", "src/d")];
    const overlaid: ArchitectureViolation[] = [{ ...sdp("src/a", "src/b"), evidence: sdp("x", "y").evidence }];
    overlaid.push(sdp("src/e", "src/f"));

    const delta = measureArchitectureViolationDelta(base, overlaid);

    expect([...delta.persisting]).toHaveLength(1);
    expect([...delta.introduced.values()]).toEqual([expect.objectContaining({ sourceComponent: "src/e" })]);
    expect(resolvedChangeSubjects(delta)).toEqual([{ family: "stableDependencies", subject: "src/c → src/d" }]);
  });

  it("reads a git mv of a leaking file as persisting, never as resolved + introduced", () => {
    const base = [leak("src/app/old.ts", "src/lib/deep.ts")];
    const overlaid = [leak("src/app/new.ts", "src/lib/deep.ts")];

    const renamed = measureArchitectureViolationDelta(base, overlaid, new Map([["src/app/new.ts", "src/app/old.ts"]]));
    expect(renamed.introduced.size).toBe(0);
    expect(renamed.resolved.size).toBe(0);
    expect(renamed.persisting.size).toBe(1);

    // Without the rename map the same move is a resolve plus an introduce.
    const unrenamed = measureArchitectureViolationDelta(base, overlaid);
    expect(unrenamed.introduced.size).toBe(1);
    expect(unrenamed.resolved.size).toBe(1);
  });

  it("diffs sets far past the report's default cap of 50 without inventing deltas", () => {
    const base = Array.from({ length: 120 }, (_, i) => sdp(`src/s${i}`, "src/t"));
    const overlaid = [...base.slice(1), sdp("src/new", "src/t")];

    const delta = measureArchitectureViolationDelta(base, overlaid);

    expect(delta.persisting.size).toBe(119);
    expect([...delta.introduced.keys()]).toHaveLength(1);
    expect(resolvedChangeSubjects(delta)).toEqual([{ family: "stableDependencies", subject: "src/s0 → src/t" }]);
  });
});

describe("collapsePersistingFindings", () => {
  it("keeps an introduced finding and collapses one whose key persists", () => {
    const delta = measureArchitectureViolationDelta(
      [sdp("src/a", "src/b")],
      [sdp("src/a", "src/b"), sdp("src/e", "src/f")],
    );

    const collapsed = collapsePersistingFindings(
      [sdpFinding("src/a", "src/b", true), sdpFinding("src/e", "src/f")],
      delta,
    );

    expect(collapsed.kept.map((f) => f.subject)).toEqual(["src/e → src/f"]);
    expect(collapsed.persisting).toEqual([{ family: "stableDependencies", subject: "src/a → src/b" }]);
    expect(collapsed.persistingByDetector.get("stableDependencies")).toBe(1);
    expect(collapsed.introducedCount).toBe(1);
    expect(collapsed.nonLocal).toEqual([]);
  });

  it("lists an introduced violation no finding carries as non-local", () => {
    const delta = measureArchitectureViolationDelta([], [sdp("src/far", "src/away")]);

    const collapsed = collapsePersistingFindings([], delta);

    expect(collapsed.nonLocal).toEqual([{ family: "stableDependencies", subject: "src/far → src/away" }]);
    expect(collapsed.introducedCount).toBe(1);
  });

  it("collapses a pre-existing diff-only cycle without a remedy and keeps one carrying a remedy", () => {
    const delta = measureArchitectureViolationDelta([], []);

    const collapsed = collapsePersistingFindings(
      [
        cycleFinding("src/a.ts", "src/b.ts", { preExisting: true }),
        cycleFinding("src/c.ts", "src/d.ts", { preExisting: true, remedy: true }),
        cycleFinding("src/e.ts", "src/f.ts"),
      ],
      delta,
    );

    expect(collapsed.kept.map((f) => f.subject)).toEqual(["src/c.ts → src/d.ts", "src/e.ts → src/f.ts"]);
    expect(collapsed.persisting).toEqual([{ family: "cycles", subject: "src/a.ts → src/b.ts" }]);
    expect(collapsed.introducedCount).toBe(1);
  });

  it("judges a report-family finding whose key neither run holds by its own preExisting flag", () => {
    const delta = measureArchitectureViolationDelta([], []);

    const collapsed = collapsePersistingFindings(
      [sdpFinding("src/a", "src/b", true), sdpFinding("src/e", "src/f")],
      delta,
    );

    expect(collapsed.kept.map((f) => f.subject)).toEqual(["src/e → src/f"]);
    expect(collapsed.persisting).toEqual([{ family: "stableDependencies", subject: "src/a → src/b" }]);
    expect(collapsed.introducedCount).toBe(1);
  });

  it("keeps a finding carrying a remedy even when its key persists and the run did not mark it preExisting", () => {
    const delta = measureArchitectureViolationDelta(
      [leak("src/app/a.ts", "src/lib/deep.ts")],
      [leak("src/app/a.ts", "src/lib/deep.ts")],
    );
    const withRemedy: DiffDetectorFinding = {
      ...leakFinding("src/app/a.ts", "src/lib/deep.ts", false),
      remedy: {
        kind: "retargetImport",
        sourceRelPath: "src/app/a.ts",
        fromRelPath: "src/lib/deep.ts",
        toRelPath: "src/lib/index.ts",
        importedNames: ["X"],
      },
    };

    const collapsed = collapsePersistingFindings([withRemedy], delta);

    expect(collapsed.kept).toEqual([withRemedy]);
    expect(collapsed.persisting).toEqual([]);
    expect(collapsed.introducedCount).toBe(0);
  });

  it("collapses a silent-coupling pair as persisting even when neither run keys it — co-change history no edge overlay moves", () => {
    // The diff run judges pairs under the query significance family and the
    // scoped asset-import rescue; the report runs do neither, so the diff
    // run's pair key can be absent from both (it groups, or drops) — never a
    // sign the change introduced it.
    const delta = measureArchitectureViolationDelta([], []);
    const pair: DiffDetectorFinding = {
      subject: "src/a.ts ~ src/b.ts",
      detail: "d",
      detector: "silentCoupling",
      endpoints: { kind: "filePair", sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" },
      evidence: { support: 9, strength: 0.6 },
    };

    const collapsed = collapsePersistingFindings([pair], delta);

    expect(collapsed.kept).toEqual([]);
    expect(collapsed.persisting).toEqual([{ family: "silentCoupling.pair", subject: "src/a.ts ~ src/b.ts" }]);
    expect(collapsed.introducedCount).toBe(0);
  });

  it("collapses a splitCandidates merge verdict as persisting — pure co-change history a diff cannot move", () => {
    const delta = measureArchitectureViolationDelta([], []);

    const collapsed = collapsePersistingFindings([mergeFinding()], delta);

    expect(collapsed.kept).toEqual([]);
    expect(collapsed.persisting).toEqual([
      { family: "splitCandidates.merge", subject: "src/core/api ~ src/mcp/tools" },
    ]);
    expect(collapsed.persistingByDetector.get("splitCandidates")).toBe(1);
    expect(collapsed.introducedCount).toBe(0);
  });

  it("keeps a splitCandidates split verdict — it is gated by a diff-added inter-cluster edge", () => {
    const delta = measureArchitectureViolationDelta([], []);
    const split: DiffDetectorFinding = {
      subject: "src/core/api",
      detail: "d",
      detector: "splitCandidates",
      endpoints: { kind: "component", component: "src/core/api" },
      evidence: { clusterCount: 2, touchedClusters: [] },
    };

    const collapsed = collapsePersistingFindings([split], delta);

    expect(collapsed.kept).toEqual([split]);
    expect(collapsed.persisting).toEqual([]);
    expect(collapsed.introducedCount).toBe(1);
  });

  it("keeps a splitCandidates merge verdict carrying a remedy — any remedy stays", () => {
    const delta = measureArchitectureViolationDelta([], []);
    const withRemedy: DiffDetectorFinding = {
      ...mergeFinding(),
      remedy: {
        kind: "retargetImport",
        sourceRelPath: "src/a.ts",
        fromRelPath: "src/b.ts",
        toRelPath: "src/lib/index.ts",
        importedNames: ["X"],
      },
    };

    const collapsed = collapsePersistingFindings([withRemedy], delta);

    expect(collapsed.kept).toEqual([withRemedy]);
    expect(collapsed.persisting).toEqual([]);
  });

  it("canonicalizes a renamed finding endpoint before keying it against the delta", () => {
    const renamedFrom = new Map([["src/app/new.ts", "src/app/old.ts"]]);
    const delta = measureArchitectureViolationDelta(
      [leak("src/app/old.ts", "src/lib/deep.ts")],
      [leak("src/app/new.ts", "src/lib/deep.ts")],
      renamedFrom,
    );

    const collapsed = collapsePersistingFindings(
      [leakFinding("src/app/new.ts", "src/lib/deep.ts")],
      delta,
      renamedFrom,
    );

    expect(collapsed.kept).toEqual([]);
    expect(collapsed.persisting).toEqual([
      { family: "leakingAbstraction.facade", subject: "src/app/new.ts → src/lib/deep.ts" },
    ]);
    expect(collapsed.introducedCount).toBe(0);
  });
});
