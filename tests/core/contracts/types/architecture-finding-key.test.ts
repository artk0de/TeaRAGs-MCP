/**
 * Stable finding identity on the finding contract (bd tea-rags-mcp-89k7k.35.18,
 * H3 T2). 89k7k.1.7 diffs the violation set of a base graph against base plus
 * overlay by fingerprint, so a key must name WHAT is violated (detector, kind,
 * endpoints) and nothing the run measured about it: no evidence, no score, no
 * order, no count, no free text. Unordered pairs are sorted, a knot keys by an
 * anchor rather than its member list, and every key carries its family's
 * revision so a detector semantics change invalidates keys on purpose.
 */

import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ARCHITECTURE_FINDING_KEY_REVISION,
  architectureViolationKey,
  diffDetectorFindingKey,
  type ArchitectureFindingKeyFamily,
  type ArchitectureViolationVariant,
} from "../../../../src/core/contracts/types/architecture-finding-key.js";
import type {
  ArchitectureFileEdge,
  ArchitectureViolation,
  FacadeLeakArchitectureViolation,
  LayeringCompositionCycleArchitectureViolation,
  LayeringKnotArchitectureViolation,
  SilentCouplingArchitectureViolation,
  SilentCouplingGroupArchitectureViolation,
  StableDependencyArchitectureViolation,
} from "../../../../src/core/contracts/types/architecture-report.js";
import type { DiffDetectorFinding } from "../../../../src/core/contracts/types/diff-detector-finding.js";

const KEY_MODULE = "../../../../src/core/contracts/types/architecture-finding-key.ts";

const fileEdge = (sourceRelPath: string, targetRelPath: string): ArchitectureFileEdge => ({
  sourceRelPath,
  targetRelPath,
  callWeight: 1,
});

function sdp(source: string, target: string, callWeight = 3): StableDependencyArchitectureViolation {
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
      callWeight,
      directoryRelation: "disjoint",
      fileEdgeCount: 1,
      fileEdges: [fileEdge(`${source}/a.ts`, `${target}/b.ts`)],
    },
  };
}

function facadeLeak(
  kind: "bypass" | "internal-reach",
  source: string,
  target: string,
): FacadeLeakArchitectureViolation {
  return {
    detector: "leakingAbstraction",
    kind,
    sourceRelPath: source,
    targetRelPath: target,
    evidence: {
      moduleDir: "src/lib",
      facadeRelPath: "src/lib/index.ts",
      adoption: 0.9,
      facadeImporterCount: 9,
      deepImporterCount: 1,
      callWeight: 2,
    },
  };
}

function silentPair(source: string, target: string, support = 5): SilentCouplingArchitectureViolation {
  return {
    detector: "silentCoupling",
    sourceRelPath: source,
    targetRelPath: target,
    evidence: {
      support,
      confidenceAB: 0.5,
      confidenceBA: 0.5,
      lift: 3,
      strength: 0.4,
      lastCoChangeAt: 1_700_000_000,
      sampleCommits: ["abc"],
      structuralVisibility: "both-walked",
      directoryRelation: "disjoint",
    },
  };
}

function silentGroup(relPath: string, partners: string[]): SilentCouplingGroupArchitectureViolation {
  const listed = partners.map((partner, i) => ({ relPath: partner, support: 5 + i, strength: 0.5 - i / 100 }));
  return {
    detector: "silentCoupling",
    kind: "group",
    relPath,
    subject: `${relPath} co-changes significantly with ${partners.length} files without a structural edge`,
    partnerCount: partners.length,
    evidence: {
      topPartners: listed.slice(0, 3),
      maxStrength: 0.5,
      drillDown: { tool: "find_co_changed", files: [relPath], limit: partners.length, hint: "drill" },
    },
    partners: listed,
  };
}

function knot(members: string[], knotOf: string): LayeringKnotArchitectureViolation {
  return {
    detector: "layering",
    kind: "knot",
    components: members.slice(0, 20),
    evidence: {
      feedbackArcSet: [],
      cutEdgeCount: members.length,
      levelsAfterCut: 3,
      memberCount: members.length,
      instabilitySpread: 0.4,
      drillDown: { knotOf, hint: "page it" },
    },
  };
}

function compositionCycle(members: string[]): LayeringCompositionCycleArchitectureViolation {
  return {
    detector: "layering",
    kind: "compositionCycle",
    components: members,
    evidence: { nestedPairs: [], nestedPairCount: 1, memberCount: members.length },
  };
}

/** One violation of every detector × kind variant, endpoints chosen to overlap across families. */
const EVERY_VARIANT: ArchitectureViolation[] = [
  sdp("src/app", "src/lib"),
  facadeLeak("bypass", "src/app/a.ts", "src/lib/deep.ts"),
  facadeLeak("internal-reach", "src/app/b.ts", "src/lib/deep.ts"),
  {
    detector: "leakingAbstraction",
    kind: "conventionPrivacy",
    sourceRelPath: "src/app/a.py",
    targetRelPath: "src/lib/b.py",
    evidence: { sourceSymbolId: "A#run", targetSymbolId: "B#_secret", rule: "python-underscore" },
  },
  silentPair("src/app/a.ts", "src/lib/deep.ts"),
  silentGroup("src/app/a.ts", ["src/x.ts", "src/y.ts"]),
  {
    detector: "shotgunSurgery",
    components: ["src/app", "src/lib", "src/ui"],
    subject: "a change spreads over 3 components",
    evidence: {
      support: 4,
      weightedSupport: 3.5,
      expectedSupport: 1.2,
      strength: 0.3,
      familyEvidence: 2.1,
      componentChanges: [5, 6, 7],
      islands: [["src/app"], ["src/lib", "src/ui"]],
      exemplarFiles: ["src/app/a.ts", "src/lib/b.ts", "src/ui/c.ts"],
      carrierFiles: [["src/app/a.ts"], ["src/lib/b.ts"], ["src/ui/c.ts"]],
      sampleCommits: ["abc"],
      sampleChanges: [["abc"]],
      drillDown: { tool: "find_co_changed", files: ["src/app/a.ts"], limit: 10, hint: "drill" },
    },
  },
  {
    detector: "mainSequence",
    component: "src/lib",
    componentKind: "directory",
    facadeRelPath: null,
    evidence: {
      zone: "pain",
      distance: 0.8,
      abstractness: 0,
      instability: 0.2,
      abstractTypeCount: 0,
      concreteTypeCount: 9,
      afferentCount: 8,
      efferentCount: 2,
      fileCount: 9,
      unmeasuredFileCount: 0,
    },
  },
  {
    detector: "hubLikeDependency",
    component: "src/lib",
    componentKind: "directory",
    facadeRelPath: null,
    evidence: {
      afferentCount: 20,
      efferentCount: 20,
      instability: 0.5,
      fileCount: 30,
      dependentComponentCount: 8,
      dependencyComponentCount: 8,
      topDependents: [],
      topDependencies: [],
      transitiveImpact: 40,
    },
  },
  knot(["src/app", "src/lib", "src/ui"], "src/lib"),
  {
    detector: "layering",
    kind: "backEdge",
    sourceComponent: "src/app",
    targetComponent: "src/lib",
    evidence: {
      callWeight: 1,
      counterFlowWeight: 4,
      fileEdgeCount: 1,
      fileEdges: [fileEdge("src/app/a.ts", "src/lib/b.ts")],
    },
  },
  {
    detector: "layering",
    kind: "abstractionBypass",
    sourceComponent: "src/app",
    targetComponent: "src/lib",
    evidence: { bypassedComponent: "src/ports", concreteAbstractness: 0, bypassedAbstractness: 1, callWeight: 2 },
  },
  compositionCycle(["src/lib", "src/lib/nested"]),
  {
    detector: "layering",
    kind: "island",
    component: "src/lib",
    evidence: { height: 1, depth: 0, afferentCount: 0, instability: 1 },
  },
  {
    detector: "layering",
    kind: "layerSkip",
    sourceComponent: "src/app",
    targetComponent: "src/lib",
    evidence: { sourceLevel: 4, targetLevel: 1, skippedLevels: 3, callWeight: 2 },
  },
  {
    detector: "norms",
    kind: "misfit",
    sourceRelPath: "src/app/a.ts",
    targetRelPath: "src/lib/deep.ts",
    evidence: {
      roleSrc: "service",
      roleDst: "controller",
      locality: "crossDomain",
      callWeight: 1,
      pairSupport: 12,
      pValue: 0.001,
      establishedDirection: { roleSrc: "controller", roleDst: "service", support: 11 },
    },
  },
];

const diffCommon = { subject: "rendered", detail: "rendered" } as const;

describe("architecture finding key (bd tea-rags-mcp-89k7k.35.18)", () => {
  it("imports nothing outside contracts — the key function stays pure", () => {
    const source = readFileSync(new URL(KEY_MODULE, import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier.startsWith("./")).toBe(true);
  });

  describe("exhaustiveness", () => {
    it("pins the detector × kind variant set — a new variant fails this check and the key switch", () => {
      expectTypeOf<ArchitectureViolationVariant>().toEqualTypeOf<
        | "stableDependencies"
        | "leakingAbstraction/bypass"
        | "leakingAbstraction/internal-reach"
        | "leakingAbstraction/conventionPrivacy"
        | "silentCoupling"
        | "silentCoupling/group"
        | "shotgunSurgery"
        | "mainSequence"
        | "hubLikeDependency"
        | "layering/knot"
        | "layering/backEdge"
        | "layering/abstractionBypass"
        | "layering/compositionCycle"
        | "layering/island"
        | "layering/layerSkip"
        | "norms/misfit"
      >();
    });

    it("rejects a violation shape the contract does not declare", () => {
      // @ts-expect-error -- an undeclared detector is not a key-able violation
      expect(() => architectureViolationKey({ detector: "novel", component: "src/x" })).toThrow();
    });

    it("keys every declared variant", () => {
      expect(EVERY_VARIANT).toHaveLength(16);
      for (const violation of EVERY_VARIANT) expect(architectureViolationKey(violation)).toEqual(expect.any(String));
    });
  });

  describe("revision", () => {
    it("stamps every key with its family's revision", () => {
      for (const violation of EVERY_VARIANT) {
        const key = architectureViolationKey(violation);
        const match = /^([A-Za-z.]+)@(\d+):/.exec(key);
        expect(match, key).not.toBeNull();
        const family = match?.[1] as ArchitectureFindingKeyFamily;
        expect(ARCHITECTURE_FINDING_KEY_REVISION[family]).toBe(Number(match?.[2]));
      }
    });

    it("declares a positive integer revision per family", () => {
      for (const revision of Object.values(ARCHITECTURE_FINDING_KEY_REVISION)) {
        expect(Number.isInteger(revision) && revision > 0).toBe(true);
      }
    });
  });

  describe("uniqueness", () => {
    it("gives every variant a distinct key even when the endpoints coincide", () => {
      const keys = EVERY_VARIANT.map(architectureViolationKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("keeps directed pairs oriented — a→b and b→a are different violations", () => {
      expect(architectureViolationKey(sdp("src/a", "src/b"))).not.toBe(architectureViolationKey(sdp("src/b", "src/a")));
    });

    it("never lets a separator inside a path merge two endpoint tuples", () => {
      expect(architectureViolationKey(sdp("src/a->x", "y"))).not.toBe(architectureViolationKey(sdp("src/a", "x->y")));
      expect(architectureViolationKey(sdp('src/a","x', "y"))).not.toBe(architectureViolationKey(sdp("src/a", 'x","y')));
    });

    it("separates conventionPrivacy edges between the same files by their symbols", () => {
      const privacy = (target: string): ArchitectureViolation => ({
        detector: "leakingAbstraction",
        kind: "conventionPrivacy",
        sourceRelPath: "a.py",
        targetRelPath: "b.py",
        evidence: { sourceSymbolId: "A#run", targetSymbolId: target, rule: "python-underscore" },
      });
      expect(architectureViolationKey(privacy("B#_one"))).not.toBe(architectureViolationKey(privacy("B#_two")));
    });
  });

  describe("stability", () => {
    it("ignores evidence, scores and the maintenance-cost tag", () => {
      const tagged: ArchitectureViolation = {
        ...sdp("src/app", "src/lib", 99),
        maintenanceCost: {} as NonNullable<ArchitectureViolation["maintenanceCost"]>,
      };
      expect(architectureViolationKey(tagged)).toBe(architectureViolationKey(sdp("src/app", "src/lib", 1)));
    });

    it("keys an unordered silent-coupling pair the same in either orientation", () => {
      expect(architectureViolationKey(silentPair("src/z.ts", "src/a.ts"))).toBe(
        architectureViolationKey(silentPair("src/a.ts", "src/z.ts", 17)),
      );
    });

    it("keys a silent-coupling group by its shared file only — never the count-bearing subject or partners", () => {
      expect(architectureViolationKey(silentGroup("src/hub.ts", ["src/x.ts", "src/y.ts"]))).toBe(
        architectureViolationKey(silentGroup("src/hub.ts", ["src/p.ts", "src/q.ts", "src/r.ts", "src/s.ts"])),
      );
    });

    it("keys a knot by its anchor: gaining a member keeps the key", () => {
      const members = Array.from({ length: 51 }, (_, i) => `src/m${String(i).padStart(2, "0")}`);
      const before = knot(members, "src/m07");
      const after = knot(["src/m07", "src/aaa-new", ...members.filter((m) => m !== "src/m07")], "src/m07");
      expect(architectureViolationKey(after)).toBe(architectureViolationKey(before));
      expect(architectureViolationKey(knot(members, "src/m08"))).not.toBe(architectureViolationKey(before));
    });

    it("keys a composition cycle by its least member, whatever the listing order", () => {
      expect(architectureViolationKey(compositionCycle(["src/lib/nested", "src/lib"]))).toBe(
        architectureViolationKey(compositionCycle(["src/lib", "src/lib/nested", "src/lib/other"])),
      );
    });

    it("keys a shotgun spread by its component set, whatever the order", () => {
      const spread = EVERY_VARIANT.find((v) => v.detector === "shotgunSurgery");
      if (spread?.detector !== "shotgunSurgery") throw new Error("fixture lost its shotgun variant");
      expect(architectureViolationKey({ ...spread, components: [...spread.components].reverse() })).toBe(
        architectureViolationKey(spread),
      );
    });

    it("keys a facade leak the same whether it classified as bypass or internal-reach", () => {
      expect(architectureViolationKey(facadeLeak("bypass", "a.ts", "b.ts"))).toBe(
        architectureViolationKey(facadeLeak("internal-reach", "a.ts", "b.ts")),
      );
    });

    it("produces the same key set across two runs over the same violations, in any order", () => {
      const first = EVERY_VARIANT.map(architectureViolationKey).sort();
      const second = [...EVERY_VARIANT].reverse().map(architectureViolationKey).sort();
      expect(second).toEqual(first);
    });
  });

  describe("diff findings", () => {
    it("keys a diff SDP finding like the report's component edge, whichever file edge carried it", () => {
      const finding: DiffDetectorFinding = {
        ...diffCommon,
        detector: "stableDependencies",
        endpoints: {
          kind: "componentEdge",
          sourceComponent: "src/app",
          targetComponent: "src/lib",
          sourceRelPath: "src/app/x.ts",
          targetRelPath: "src/lib/y.ts",
        },
        evidence: { sourceInstability: 0.1, targetInstability: 0.9 },
      };
      expect(diffDetectorFindingKey(finding)).toBe(architectureViolationKey(sdp("src/app", "src/lib")));
    });

    it("keys a diff leak like the report's facade leak", () => {
      const finding: DiffDetectorFinding = {
        ...diffCommon,
        detector: "leakingAbstraction",
        endpoints: { kind: "fileEdge", sourceRelPath: "src/app/a.ts", targetRelPath: "src/lib/deep.ts" },
        evidence: { facadeRelPath: "src/lib/index.ts" },
      };
      expect(diffDetectorFindingKey(finding)).toBe(
        architectureViolationKey(facadeLeak("internal-reach", "src/app/a.ts", "src/lib/deep.ts")),
      );
    });

    it("keys a changed-side-first diff pair like the report's lexicographic pair", () => {
      const finding: DiffDetectorFinding = {
        ...diffCommon,
        detector: "silentCoupling",
        endpoints: { kind: "filePair", sourceRelPath: "src/z.ts", targetRelPath: "src/a.ts" },
        evidence: { support: 3, strength: 0.2 },
      };
      expect(diffDetectorFindingKey(finding)).toBe(architectureViolationKey(silentPair("src/a.ts", "src/z.ts")));
    });

    it("keys a diff group like the report's group, whatever either side counts", () => {
      const finding: DiffDetectorFinding = {
        ...diffCommon,
        detector: "silentCoupling",
        endpoints: { kind: "fileGroup", relPath: "src/hub.ts", partnerCount: 11 },
        evidence: { topPartners: [] },
      };
      expect(diffDetectorFindingKey(finding)).toBe(architectureViolationKey(silentGroup("src/hub.ts", ["src/x.ts"])));
    });

    it("keys a diff main-sequence finding like the report's component", () => {
      const finding: DiffDetectorFinding = {
        ...diffCommon,
        detector: "mainSequence",
        endpoints: { kind: "component", component: "src/lib" },
        evidence: { distanceBefore: 0.1, distanceAfter: 0.8, instabilityBefore: 0.5, instabilityAfter: 0.2, edges: [] },
      };
      const report = EVERY_VARIANT.find((v) => v.detector === "mainSequence");
      if (!report) throw new Error("fixture lost its mainSequence variant");
      expect(diffDetectorFindingKey(finding)).toBe(architectureViolationKey(report));
    });

    it("keys the diff-only families apart from every report key, with a revision each", () => {
      const diffOnly: DiffDetectorFinding[] = [
        {
          ...diffCommon,
          detector: "cycles",
          endpoints: { kind: "fileEdge", sourceRelPath: "src/app/a.ts", targetRelPath: "src/lib/deep.ts" },
          evidence: { path: ["src/app/a.ts", "src/lib/deep.ts", "src/app/a.ts"] },
        },
        {
          ...diffCommon,
          detector: "facadeContract",
          endpoints: { kind: "file", relPath: "src/lib/index.ts", component: "src/lib" },
          evidence: { droppedNames: [] },
        },
        {
          ...diffCommon,
          detector: "splitCandidates",
          endpoints: { kind: "component", component: "src/lib" },
          evidence: { clusterCount: 2, touchedClusters: [] },
        },
        {
          ...diffCommon,
          detector: "splitCandidates",
          endpoints: { kind: "componentPair", componentA: "src/lib", componentB: "src/app" },
          evidence: {
            strength: 0.4,
            sideA: { changedFileCount: 0, changedFiles: [] },
            sideB: { changedFileCount: 0, changedFiles: [] },
          },
        },
      ];
      const reportKeys = new Set(EVERY_VARIANT.map(architectureViolationKey));
      const diffKeys = diffOnly.map(diffDetectorFindingKey);
      expect(new Set(diffKeys).size).toBe(diffKeys.length);
      for (const key of diffKeys) {
        expect(reportKeys.has(key)).toBe(false);
        const family = /^([A-Za-z.]+)@(\d+):/.exec(key)?.[1] as ArchitectureFindingKeyFamily;
        expect(ARCHITECTURE_FINDING_KEY_REVISION[family]).toBeGreaterThan(0);
      }
    });

    it("keys a merge candidate the same whichever side the diff names first", () => {
      const merge = (componentA: string, componentB: string): DiffDetectorFinding => ({
        ...diffCommon,
        detector: "splitCandidates",
        endpoints: { kind: "componentPair", componentA, componentB },
        evidence: {
          strength: 0.4,
          sideA: { changedFileCount: 0, changedFiles: [] },
          sideB: { changedFileCount: 0, changedFiles: [] },
        },
      });
      expect(diffDetectorFindingKey(merge("src/b", "src/a"))).toBe(diffDetectorFindingKey(merge("src/a", "src/b")));
    });
  });
});
