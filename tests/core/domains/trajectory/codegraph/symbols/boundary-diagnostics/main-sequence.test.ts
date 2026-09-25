/**
 * Stable Abstractions Principle / main sequence (bd tea-rags-mcp-r8hme.8): per
 * component, abstractness A = abstract / (abstract + concrete) types summed over
 * its files, instability I from the component graph, distance D = |A + I - 1|.
 * A component far from the main sequence sits in the zone of pain (stable and
 * concrete, A + I < 1) or the zone of uselessness (unstable and abstract).
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
  TypeAbstractnessCensus,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  DEFAULT_MAIN_SEQUENCE_MIN_TYPE_COUNT,
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  detectMainSequenceDeviations,
  MAIN_SEQUENCE_DISTANCE_FLOOR,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string, typeAbstractness?: TypeAbstractnessCensus) {
  return { relPath, language: "typescript", symbolCount: 1, ...(typeAbstractness ? { typeAbstractness } : {}) };
}

function edge(sourceRelPath: string, targetRelPath: string): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

const census = (abstractTypeCount: number, concreteTypeCount: number) => ({ abstractTypeCount, concreteTypeCount });

/**
 * `core/`   — 6 concrete types, 6 dependents, no dependency: A 0, I 0 → pain.
 * `ports/`  — 5 abstract types, depends outward only: A 1, I 1 → uselessness.
 * `app/`    — 6 concrete types, depends outward only: A 0, I 1 → on the sequence.
 * `vendor/` — measured, no type.  `thin/` — one connection.  `legacy/` — never measured.
 */
function graph(): FileDependencyGraph {
  const files = [file("core/a.ts", census(0, 3)), file("core/b.ts", census(0, 3)), file("vendor/v.ts", census(0, 0))];
  const edges: FileDependencyEdge[] = [];
  for (let i = 1; i <= 6; i++) {
    files.push(file(`app/c${i}.ts`, census(0, 1)));
    edges.push(edge(`app/c${i}.ts`, "core/b.ts"));
  }
  for (let i = 1; i <= 5; i++) {
    files.push(file(`ports/p${i}.ts`, census(1, 0)), file(`legacy/l${i}.ts`));
    edges.push(edge(`ports/p${i}.ts`, "vendor/v.ts"), edge(`legacy/l${i}.ts`, "vendor/v.ts"));
  }
  files.push(file("thin/t.ts", census(0, 2)));
  edges.push(edge("thin/t.ts", "vendor/v.ts"));
  return { files, edges };
}

function judge(g: FileDependencyGraph, options = {}) {
  return detectMainSequenceDeviations(buildComponentGraph(g, []), g.files, options);
}

describe("detectMainSequenceDeviations", () => {
  it("reports components far from the main sequence, by zone, with their census and coupling", () => {
    expect(judge(graph()).violations).toEqual([
      {
        component: "core",
        kind: "directory",
        facadeRelPath: null,
        zone: "pain",
        distance: 1,
        abstractness: 0,
        instability: 0,
        abstractTypeCount: 0,
        concreteTypeCount: 6,
        afferentCount: 6,
        efferentCount: 0,
        fileCount: 2,
        unmeasuredFileCount: 0,
      },
      {
        component: "ports",
        kind: "directory",
        facadeRelPath: null,
        zone: "uselessness",
        distance: 1,
        abstractness: 1,
        instability: 1,
        abstractTypeCount: 5,
        concreteTypeCount: 0,
        afferentCount: 0,
        efferentCount: 5,
        fileCount: 5,
        unmeasuredFileCount: 0,
      },
    ]);
  });

  it("judges only components with trustworthy I and A, counting the rest by reason", () => {
    expect(judge(graph()).summary).toMatchObject({
      componentCount: 6,
      judgedComponentCount: 3,
      violationCount: 2,
      painCount: 1,
      uselessnessCount: 1,
      meanDistance: 2 / 3,
      minConnectionCount: DEFAULT_SDP_MIN_CONNECTION_COUNT,
      minTypeCount: DEFAULT_MAIN_SEQUENCE_MIN_TYPE_COUNT,
      excluded: { lowConnectionCount: 1, unmeasured: 1, fewTypes: 1, unobservableAbstractness: 0 },
      abstractTypeShareByLanguage: { typescript: 5 / 19 },
    });
    expect(DEFAULT_MAIN_SEQUENCE_MIN_TYPE_COUNT).toBe(5);
  });

  it("draws the distance cut with Otsu when the population allows, never at or below the floor", () => {
    const { summary } = judge(graph());

    expect(MAIN_SEQUENCE_DISTANCE_FLOOR).toBe(0.5);
    expect(summary).toMatchObject({ distanceThresholdMethod: "majority", distanceThreshold: 0.5 });
    expect(summary.distanceSeparability).toBeUndefined();
  });

  it("does not report a component exactly at the floor", () => {
    // `half/`: A 0, I 0.5 → D 0.5, not strictly above the floor.
    const g = graph();
    for (let i = 1; i <= 3; i++) {
      g.files.push(file(`half/h${i}.ts`, census(0, 2)), file(`deps/d${i}.ts`));
      g.edges.push(edge(`half/h${i}.ts`, "vendor/v.ts"), edge(`deps/d${i}.ts`, `half/h${i}.ts`));
    }

    const report = judge(g);

    expect(report.violations.map((v) => v.component)).toEqual(["core", "ports"]);
    expect(report.summary.judgedComponentCount).toBe(4);
  });

  it("does not judge a component whose languages declare abstractions too rarely for it to show one", () => {
    // Six Ruby types in a corpus where Ruby declares no abstraction: A = 0 is
    // what any Ruby component would read, so it says nothing about this one.
    const g = graph();
    for (let i = 1; i <= 6; i++) {
      g.files.push({ ...file(`rb/r${i}.rb`, census(0, 1)), language: "ruby" });
      g.edges.push(edge(`rb/r${i}.rb`, "core/a.ts"));
    }

    const report = judge(g);

    expect(report.summary.excluded.unobservableAbstractness).toBe(1);
    expect(report.summary.abstractTypeShareByLanguage.ruby).toBe(0);
    expect(report.violations.map((v) => v.component)).toEqual(["core", "ports"]);
  });

  it("raises the type floor on request", () => {
    expect(judge(graph(), { minTypeCount: 7 }).summary.excluded.fewTypes).toBe(4);
  });

  it("reports only components holding an in-scope file, judged against the whole graph", () => {
    const report = judge(graph(), { sourcePathPattern: "ports/**" });

    expect(report.violations.map((v) => v.component)).toEqual(["ports"]);
    expect(report.summary.scope).toEqual({ sourcePathPattern: "ports/**", outOfScopeComponentCount: 2 });
    expect(report.summary.meanDistance).toBe(2 / 3);
  });
});
