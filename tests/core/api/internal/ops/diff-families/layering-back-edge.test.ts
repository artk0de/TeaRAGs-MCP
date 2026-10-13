/**
 * The diff-scoped `layeringBackEdge` family (bd tea-rags-mcp-89k7k.1.19.3,
 * spec D8/D9): a diff-added edge whose source component sits at a LOWER
 * inferred level than its target — the foundation side now leans on the stack
 * above it. Levels and knots come from the whole-repo layering model through
 * the injected read-only `LayeringReading`; composition (a directory and its
 * own nested directory) is never a back-edge; `preExisting` marks a component
 * pair another edge already carried before the change.
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
  type DiffDetectorGraphReader,
} from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import { diffDetectorFindingKey } from "../../../../../../src/core/contracts/types/architecture-finding-key.js";
import type { LayeringReading } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

/** Component of each fixture file: its directory under `src/`. */
const FILES: Readonly<Record<string, string>> = {
  "src/core/a.ts": "core",
  "src/core/other.ts": "core",
  "src/lib/l.ts": "lib",
  "src/app/b.ts": "app",
  "src/app/c.ts": "app",
  "src/parent/p.ts": "parent",
  "src/parent/nested/n.ts": "parent/nested",
  "src/fresh/f.ts": "fresh",
};

/** core L0 ← lib L1 ← app L2; parent L0 holds parent/nested L1. `fresh` is unknown to the layering. */
const LEVELS: Readonly<Record<string, number>> = { core: 0, lib: 1, app: 2, parent: 0, "parent/nested": 1 };

const catalog = catalogOf(
  new Map<string, Omit<ComponentFact, "connectionCount">>(
    Object.entries(FILES).map(([relPath, name]) => [relPath, { name, instability: 0.5, distanceFromMainSequence: 0 }]),
  ),
);

/** A hand-built reading: the levels above, the knots a stub names, composition by path nesting. */
function layeringOf(knots: Readonly<Record<string, readonly string[]>> = {}): LayeringReading {
  return {
    positionOf: (component) =>
      component in LEVELS ? { level: LEVELS[component] ?? 0, depth: 0, inKnot: false } : undefined,
    knotClosedBy: (source, target) => {
      const knot = knots[`${source} -> ${target}`];
      return knot === undefined ? undefined : [...knot];
    },
    isComposition: (source, target) => source.startsWith(`${target}/`) || target.startsWith(`${source}/`),
    filesOf: (component) =>
      Object.entries(FILES)
        .filter(([, name]) => name === component)
        .map(([relPath]) => relPath),
  };
}

function runWith(
  deps: { layering?: LayeringReading; graph?: DiffDetectorGraphReader; baseEdges?: DiffDetectorBaseEdgeReader },
  changedFiles: readonly string[],
  overlayEdges: readonly FixtureEdge[],
): DiffDetectorFindings {
  return new DiffDetectorRun({
    graph: deps.graph ?? graphOf([]),
    catalog,
    ...(deps.layering !== undefined ? { layering: deps.layering } : {}),
    ...(deps.baseEdges !== undefined ? { baseEdges: deps.baseEdges } : {}),
  }).run({ changedFiles }, overlayOf(overlayEdges, changedFiles));
}

const backEdgesOf = (result: DiffDetectorFindings) =>
  result.findings.filter((finding) => finding.detector === "layeringBackEdge");

describe("layeringBackEdge diff family", () => {
  it("reports a diff-added edge from a lower level up to a higher one, with both levels", () => {
    const result = runWith({ layering: layeringOf() }, ["src/core/a.ts"], [["src/core/a.ts", "src/app/b.ts"]]);

    expect(backEdgesOf(result)).toEqual([
      expect.objectContaining({
        detector: "layeringBackEdge",
        subject: "src/core/a.ts -> src/app/b.ts",
        endpoints: {
          kind: "componentEdge",
          sourceComponent: "core",
          targetComponent: "app",
          sourceRelPath: "src/core/a.ts",
          targetRelPath: "src/app/b.ts",
        },
        evidence: { sourceLevel: 0, targetLevel: 2 },
      }),
    ]);
    const [finding] = backEdgesOf(result);
    expect(finding?.detail).toContain("L0");
    expect(finding?.detail).toContain("L2");
    expect(finding?.preExisting).toBeUndefined();
  });

  it("lists the knot the edge closes, sorted", () => {
    const result = runWith(
      { layering: layeringOf({ "core -> app": ["app", "core", "lib"] }) },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/app/b.ts"]],
    );

    expect(backEdgesOf(result).map((finding) => finding.evidence)).toEqual([
      { sourceLevel: 0, targetLevel: 2, closesKnot: ["app", "core", "lib"] },
    ]);
  });

  it("never reports composition: a parent directory reaching into its own nested directory", () => {
    const result = runWith(
      { layering: layeringOf() },
      ["src/parent/p.ts"],
      [["src/parent/p.ts", "src/parent/nested/n.ts"]],
    );

    expect(backEdgesOf(result)).toEqual([]);
  });

  it("judges only upward edges between components the layering knows", () => {
    const result = runWith(
      { layering: layeringOf() },
      ["src/app/b.ts", "src/lib/l.ts", "src/core/a.ts"],
      [
        ["src/app/b.ts", "src/core/a.ts"], // downward
        ["src/lib/l.ts", "src/core/a.ts"], // downward
        ["src/core/a.ts", "src/fresh/f.ts"], // target unknown to the layering
        ["src/core/a.ts", "src/parent/p.ts"], // same level, lateral
      ],
    );

    expect(backEdgesOf(result)).toEqual([]);
  });

  it("marks preExisting when another file of the pair already carried it at the diff base", () => {
    // a.ts imported app/c.ts at the base and still does; the diff adds a.ts -> app/b.ts.
    const result = runWith(
      { layering: layeringOf(), baseEdges: baseEdgesOf({ "src/core/a.ts": ["src/app/c.ts"] }) },
      ["src/core/a.ts"],
      [
        ["src/core/a.ts", "src/app/c.ts"],
        ["src/core/a.ts", "src/app/b.ts"],
      ],
    );

    expect(backEdgesOf(result).map((finding) => [finding.subject, finding.preExisting])).toEqual([
      ["src/core/a.ts -> src/app/b.ts", true],
    ]);
  });

  it("marks preExisting when an unchanged file of the source component holds the pair in the index", () => {
    const result = runWith(
      { layering: layeringOf(), graph: graphOf([["src/core/other.ts", "src/app/c.ts"]]) },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/app/b.ts"]],
    );

    expect(backEdgesOf(result).map((finding) => finding.preExisting)).toEqual([true]);
  });

  it("does not mark preExisting when the base held no edge of the pair", () => {
    const result = runWith(
      { layering: layeringOf(), baseEdges: baseEdgesOf({ "src/core/a.ts": ["src/lib/l.ts"] }) },
      ["src/core/a.ts"],
      [["src/core/a.ts", "src/app/b.ts"]],
    );

    expect(backEdgesOf(result).map((finding) => finding.preExisting)).toEqual([undefined]);
  });

  it("reports a built status row with the family's finding count", () => {
    const result = runWith({ layering: layeringOf() }, ["src/core/a.ts"], [["src/core/a.ts", "src/app/b.ts"]]);

    expect(result.detectors.find((row) => row.detector === "layeringBackEdge")).toEqual({
      detector: "layeringBackEdge",
      built: true,
      findingCount: 1,
    });
  });

  it("answers built:false with a reason when no layering reading was wired", () => {
    const result = runWith({}, ["src/core/a.ts"], [["src/core/a.ts", "src/app/b.ts"]]);

    expect(backEdgesOf(result)).toEqual([]);
    expect(result.detectors.find((row) => row.detector === "layeringBackEdge")).toEqual({
      detector: "layeringBackEdge",
      built: false,
      reason: "no layering reading",
      findingCount: 0,
    });
  });

  it("keys a finding as the report's layering back-edge over the same component pair", () => {
    const result = runWith({ layering: layeringOf() }, ["src/core/a.ts"], [["src/core/a.ts", "src/app/b.ts"]]);
    const [finding] = backEdgesOf(result);

    expect(finding && diffDetectorFindingKey(finding)).toBe('layering.backEdge@1:["core","app"]');
  });
});
