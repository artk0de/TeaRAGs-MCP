/**
 * The diff-scoped `hubLike` family (bd tea-rags-mcp-89k7k.1.19.4, spec D8/D9):
 * a diff-added edge that carries a component across the whole-repo hub cuts —
 * Ca AND the hub's Ce (edges into the measured foundation excluded, bd
 * tea-rags-mcp-g77p3) both past their adaptive cuts, coupling balanced. The
 * counts and the verdict are the whole-repo detector's, read through the
 * injected `HubLikeDependencyReading`; `preExisting` marks a component that was
 * already a hub before the change.
 */
import { describe, expect, it } from "vitest";

import {
  baseEdgesOf,
  catalogOf,
  graphOf,
  overlayOf,
  type ComponentFact,
  type FixtureEdge,
} from "../__helpers__/diff-run-fixtures.js";
import {
  DiffDetectorRun,
  type DiffDetectorBaseEdgeReader,
  type DiffDetectorFindings,
} from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import { diffDetectorFindingKey } from "../../../../../../src/core/contracts/types/architecture-finding-key.js";
import type {
  HubLikeDependencyFanCounts,
  HubLikeDependencyReading,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

/** Component of each fixture file: its directory under `src/`. */
const FILES: Readonly<Record<string, string>> = {
  "src/core/a.ts": "core",
  "src/core/other.ts": "core",
  "src/app/b.ts": "app",
  "src/lib/l.ts": "lib",
  "src/lib/base.ts": "lib",
  "src/contracts/t.ts": "contracts",
  "src/core/inner/i.ts": "core/inner",
};

const catalog = catalogOf(
  new Map<string, Omit<ComponentFact, "connectionCount">>(
    Object.entries(FILES).map(([relPath, name]) => [relPath, { name, instability: 0.5, distanceFromMainSequence: 0 }]),
  ),
);

/** The stubbed whole-repo cuts: Ca at least 8, the hub's Ce at least 11. */
const isHubPastStubCuts = (fan: HubLikeDependencyFanCounts): boolean =>
  fan.afferentCount >= 8 && fan.efferentCount >= 11;

/** A hand-built reading: `core` at the given counts, every other component quiet, `contracts` the foundation, `core/inner` nested in `core`, `a.ts` subclassing `base.ts`. */
function hubLikeOf(core: HubLikeDependencyFanCounts & { compositionRoot?: true }): HubLikeDependencyReading {
  const quiet: HubLikeDependencyFanCounts = { afferentCount: 1, efferentCount: 1, connectionCount: 2 };
  return {
    fanCountsOf: (component) => (component === "core" ? core : component in COMPONENTS ? quiet : undefined),
    isFoundation: (component) => component === "contracts",
    isContainment: (source, target) => source.startsWith(`${target}/`) || target.startsWith(`${source}/`),
    // a.ts declares a type whose supertype lib/base.ts declares.
    isInheritance: (sourceRelPath, targetRelPath) =>
      sourceRelPath === "src/core/a.ts" && targetRelPath === "src/lib/base.ts",
    isHub: isHubPastStubCuts,
  };
}
const COMPONENTS: Readonly<Record<string, true>> = Object.fromEntries(
  Object.values(FILES).map((component) => [component, true as const]),
);

const BELOW_CUT = { afferentCount: 8, efferentCount: 10, connectionCount: 18 } as const;

function runWith(
  deps: { hubLike?: HubLikeDependencyReading; baseEdges?: DiffDetectorBaseEdgeReader },
  changedFiles: readonly string[],
  overlayEdges: readonly FixtureEdge[],
): DiffDetectorFindings {
  return new DiffDetectorRun({
    graph: graphOf([]),
    catalog,
    ...(deps.hubLike !== undefined ? { hubLike: deps.hubLike } : {}),
    ...(deps.baseEdges !== undefined ? { baseEdges: deps.baseEdges } : {}),
  }).run({ changedFiles }, overlayOf(overlayEdges, changedFiles));
}

const hubFindingsOf = (result: DiffDetectorFindings) => result.findings.filter((f) => f.detector === "hubLike");

describe("hubLike diff family", () => {
  it("reports the component the diff's own edge carries across the efferent cut, with before/after and the edge", () => {
    const result = runWith(
      { hubLike: hubLikeOf(BELOW_CUT), baseEdges: baseEdgesOf({ "src/core/a.ts": [] }) },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/app/b.ts"]],
    );

    expect(hubFindingsOf(result)).toEqual([
      expect.objectContaining({
        detector: "hubLike",
        endpoints: { kind: "component", component: "core" },
        subject: "core",
        evidence: {
          afferentBefore: 8,
          efferentBefore: 10,
          afferentAfter: 8,
          efferentAfter: 11,
          edges: [{ sourceRelPath: "src/core/a.ts", targetRelPath: "src/app/b.ts" }],
        },
      }),
    ]);
    expect(hubFindingsOf(result)[0]?.preExisting).toBeUndefined();
    expect(hubFindingsOf(result)[0]?.compositionRoot).toBeUndefined();
  });

  it("does not move Ce on a new edge into the measured foundation", () => {
    const result = runWith(
      { hubLike: hubLikeOf(BELOW_CUT), baseEdges: baseEdgesOf({ "src/core/a.ts": [] }) },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/contracts/t.ts"]],
    );

    expect(hubFindingsOf(result)).toEqual([]);
  });

  // bd tea-rags-mcp-j5gti: a parent↔nested edge is containment — the detector
  // counts it on neither axis, so the diff does not either.
  it("moves neither Ca nor Ce on a new edge between a component and its own nested component", () => {
    const result = runWith(
      {
        hubLike: hubLikeOf({ afferentCount: 7, efferentCount: 10, connectionCount: 17 }),
        baseEdges: baseEdgesOf({ "src/core/a.ts": [], "src/core/inner/i.ts": [] }),
      },
      ["src/core/a.ts", "src/core/inner/i.ts"],
      [
        ["src/core/a.ts", "src/core/inner/i.ts"],
        ["src/core/inner/i.ts", "src/core/a.ts"],
      ],
    );

    expect(hubFindingsOf(result)).toEqual([]);
  });

  it("does not move Ce when the source file already carried an efferent edge before the change", () => {
    // a.ts already reached lib at the base: it is one of core's Ce files already.
    const result = runWith(
      { hubLike: hubLikeOf(BELOW_CUT), baseEdges: baseEdgesOf({ "src/core/a.ts": ["src/lib/l.ts"] }) },
      ["src/core/a.ts"],
      [
        ["src/core/a.ts", "src/lib/l.ts"],
        ["src/core/a.ts", "src/app/b.ts"],
      ],
    );

    expect(hubFindingsOf(result)).toEqual([]);
  });

  // bd tea-rags-mcp-r8hme.52.18: an edge onto a file declaring one of the
  // source file's supertypes is inheritance, not efferent coupling.
  it("does not move Ce on a new edge onto a file declaring the source's supertype", () => {
    const result = runWith(
      { hubLike: hubLikeOf(BELOW_CUT), baseEdges: baseEdgesOf({ "src/core/a.ts": [] }) },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/lib/base.ts"]],
    );

    expect(hubFindingsOf(result)).toEqual([]);
  });

  it("moves Ce when a file that only inherited before the change gains a coupling edge", () => {
    // a.ts reached only its supertype's file at the base: not one of core's Ce files.
    const result = runWith(
      { hubLike: hubLikeOf(BELOW_CUT), baseEdges: baseEdgesOf({ "src/core/a.ts": ["src/lib/base.ts"] }) },
      ["src/core/a.ts"],
      [
        ["src/core/a.ts", "src/lib/base.ts"],
        ["src/core/a.ts", "src/app/b.ts"],
      ],
    );

    expect(hubFindingsOf(result)).toEqual([
      expect.objectContaining({ evidence: expect.objectContaining({ efferentBefore: 10, efferentAfter: 11 }) }),
    ]);
  });

  it("marks preExisting when the component was already a hub before the change", () => {
    const result = runWith(
      {
        hubLike: hubLikeOf({ afferentCount: 9, efferentCount: 11, connectionCount: 20 }),
        baseEdges: baseEdgesOf({ "src/core/a.ts": [] }),
      },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/app/b.ts"]],
    );

    expect(hubFindingsOf(result).map((finding) => [finding.subject, finding.preExisting])).toEqual([["core", true]]);
  });

  it("stamps compositionRoot on a declared composition root, as the whole-repo hub detector does", () => {
    const result = runWith(
      {
        hubLike: hubLikeOf({ ...BELOW_CUT, compositionRoot: true }),
        baseEdges: baseEdgesOf({ "src/core/a.ts": [] }),
      },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/app/b.ts"]],
    );

    expect(hubFindingsOf(result).map((finding) => finding.compositionRoot)).toEqual([true]);
  });

  it("answers built:false with a reason when no hub reading was wired", () => {
    const result = runWith({}, ["src/core/a.ts"], [["src/core/a.ts", "src/app/b.ts"]]);

    expect(result.detectors.find((entry) => entry.detector === "hubLike")).toEqual({
      detector: "hubLike",
      built: false,
      reason: "no hub-like reading",
      findingCount: 0,
    });
  });

  it("keys a finding as the report's hub-like violation of the same component", () => {
    const result = runWith(
      { hubLike: hubLikeOf(BELOW_CUT), baseEdges: baseEdgesOf({ "src/core/a.ts": [] }) },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/app/b.ts"]],
    );

    const [finding] = hubFindingsOf(result);
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    expect(diffDetectorFindingKey(finding)).toBe(`hubLikeDependency@1:${JSON.stringify(["core"])}`);
  });
});
