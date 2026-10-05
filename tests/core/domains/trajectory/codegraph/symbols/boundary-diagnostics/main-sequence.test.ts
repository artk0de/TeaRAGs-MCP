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
  MAIN_SEQUENCE_STABLE_CONCRETE_CALM_REASON,
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

/**
 * Volatility gate on the zone of pain (bd tea-rags-mcp-r8hme.14): per Martin,
 * stable + concrete hurts only for a component that keeps changing — `String`
 * is stable, concrete and fine. A component's volatility is the mean per-file
 * change count over its files; the cut is drawn from the data (Otsu over the
 * judged components' volatilities, never at or below the median file's).
 */
describe("detectMainSequenceDeviations — volatility gate on the zone of pain", () => {
  /** Every file of `graph()` changed `base` times, `core/` files `coreCount` times. */
  function volatility(g: FileDependencyGraph, coreCount: number, base = 2): Map<string, number> {
    return new Map(g.files.map((f) => [f.relPath, f.relPath.startsWith("core/") ? coreCount : base]));
  }

  it("keeps a stable, concrete component that keeps changing in the zone of pain, with its volatility", () => {
    const g = graph();

    const report = judge(g, { fileVolatility: volatility(g, 9) });

    expect(report.violations.map((v) => [v.component, v.zone])).toEqual([
      ["core", "pain"],
      ["ports", "uselessness"],
    ]);
    expect(report.violations[0].volatility).toEqual({
      value: 9,
      measuredFileCount: 2,
      threshold: 2,
      label: "volatile",
    });
    expect(report.summary.painCount).toBe(1);
    expect(report.summary.excluded.stableConcreteCalm).toBe(0);
  });

  it("drops a stable, concrete component that does not change out of the zone of pain, counting it as calm", () => {
    const g = graph();

    const report = judge(g, { fileVolatility: volatility(g, 1) });

    expect(report.violations.map((v) => v.component)).toEqual(["ports"]);
    expect(report.summary).toMatchObject({
      violationCount: 1,
      painCount: 0,
      uselessnessCount: 1,
      excluded: { stableConcreteCalm: 1 },
    });
    expect(MAIN_SEQUENCE_STABLE_CONCRETE_CALM_REASON).toMatch(/volatil|chang/);
  });

  it("leaves the zone of uselessness to distance alone, whatever its volatility", () => {
    const g = graph();
    const fileVolatility = volatility(g, 9);
    for (let i = 1; i <= 5; i++) fileVolatility.set(`ports/p${i}.ts`, 1);

    const report = judge(g, { fileVolatility });

    expect(report.violations.map((v) => [v.component, v.zone])).toEqual([
      ["core", "pain"],
      ["ports", "uselessness"],
    ]);
    expect(report.violations[1].volatility?.label).toBe("calm");
  });

  it("derives the volatility cut from the data, so rescaling every change count rescales the cut and keeps the verdicts", () => {
    const g = graph();
    const scaled = new Map([...volatility(g, 9)].map(([relPath, n]) => [relPath, n * 10]));

    const base = judge(g, { fileVolatility: volatility(g, 9) });
    const report = judge(g, { fileVolatility: scaled });

    expect(report.summary.volatility?.threshold).toBe((base.summary.volatility?.threshold ?? 0) * 10);
    expect(report.violations.map((v) => [v.component, v.volatility?.label])).toEqual(
      base.violations.map((v) => [v.component, v.volatility?.label]),
    );
  });

  /**
   * `graph()` plus one stable, mostly concrete component per entry of
   * `libCommits` (A = 1/6, so the corpus share keeps every judged component's
   * abstractness observable), each file of `lib<n>/` changed that many times —
   * enough judged components for Otsu.
   */
  function withLibraries(coreCommits: number, libCommits: readonly number[]) {
    const g = graph();
    const fileVolatility = volatility(g, coreCommits);
    libCommits.forEach((commits, index) => {
      const lib = `lib${index + 1}`;
      for (let i = 1; i <= 2; i++) {
        g.files.push(file(`${lib}/f${i}.ts`, census(1, 5)));
        fileVolatility.set(`${lib}/f${i}.ts`, commits);
      }
      for (let i = 1; i <= 6; i++) g.edges.push(edge(`app/c${i}.ts`, `${lib}/f1.ts`));
    });
    return { g, fileVolatility };
  }

  const painComponents = (report: ReturnType<typeof judge>) =>
    report.violations.filter((v) => v.zone === "pain").map((v) => v.component);

  it("floors the cut at the median file and splits the component population with Otsu once it is large enough", () => {
    // Four calm libraries (1 change per file), four hot ones (20); `core/` at 3
    // clears the median file (2) but sits with the calm class.
    const { g, fileVolatility } = withLibraries(3, [1, 1, 1, 1, 20, 20, 20, 20]);

    const report = judge(g, { fileVolatility });

    expect(report.summary.volatility).toMatchObject({ thresholdMethod: "otsu", fileMedian: 2 });
    expect(report.summary.volatility?.threshold).toBeGreaterThan(3);
    expect(painComponents(report)).toEqual(["lib5", "lib6", "lib7", "lib8"]);
    expect(report.summary.excluded.stableConcreteCalm).toBe(5);
  });

  it("refuses the log-scale cut when the population is one continuum and falls to the file median", () => {
    // Calm libraries at 2, active ones at 8 like `core/`, one extreme at 60.
    // The judged components' log volatilities are [ln2 ×5 (`ports` + four
    // calm libs), ln8 ×4 (`core` + three hot libs), ln60] — η = 0.8004/1.1252
    // ≈ 0.711, below the 0.8 separability gate (bd tea-rags-mcp-r8hme.46):
    // three levels of mass, none separated like two modes, so the cut would
    // be arbitrary and the threshold falls back to the documented file
    // median (2 here).
    const { g, fileVolatility } = withLibraries(8, [2, 2, 2, 2, 8, 8, 8, 60]);

    const report = judge(g, { fileVolatility });

    expect(report.summary.volatility).toMatchObject({ thresholdMethod: "fileMedian", threshold: 2 });
    // The η that failed the gate is still reported, so the verdict's basis is
    // visible instead of silent.
    expect(report.summary.volatility?.separability).toBeCloseTo(0.7113, 3);
    // The verdicts are the ones the floor draws: every component above the
    // median file stays in pain, the calm ones drop out exactly as before.
    expect(painComponents(report)).toEqual(["core", "lib5", "lib6", "lib7", "lib8"]);
    expect(report.summary.excluded.stableConcreteCalm).toBe(4);
  });

  it("splits change counts on a log scale, so a few very hot components do not drag the cut past the active ones", () => {
    // Calm libraries at 1, active ones at 8 like `core/`, one extreme at 60.
    // On the raw scale the extreme alone is the upper class and `core/` reads
    // calm; change counts spread multiplicatively, and on the log scale the
    // split falls between calm and active. The judged components' log
    // volatilities [0 ×6 (calm libs), ln2 (`ports`), ln8 ×3 (`core` + two hot
    // libs), ln60] read η = 1.4280/1.7423 ≈ 0.820 — at or above the
    // separability gate, so the cut is trusted (bd tea-rags-mcp-r8hme.46's
    // fixture predecessor at η ≈ 0.711, one continuum, no longer is).
    const { g, fileVolatility } = withLibraries(8, [1, 1, 1, 1, 1, 1, 8, 8, 60]);

    const report = judge(g, { fileVolatility });

    expect(report.summary.volatility?.thresholdMethod).toBe("otsu");
    expect(report.summary.volatility?.separability).toBeCloseTo(0.8196, 3);
    // The cut is the ln2 | ln8 midpoint: exp(ln4) = 4, between the calm and
    // the active class, with the 60-extreme kept OUT of the upper class.
    expect(report.summary.volatility?.threshold).toBeCloseTo(4, 9);
    expect(painComponents(report)).toEqual(["core", "lib7", "lib8", "lib9"]);
    expect(report.summary.excluded.stableConcreteCalm).toBe(6);
  });

  it("keeps a pain component none of whose files has a volatility reading, and gates nothing without readings", () => {
    const g = graph();
    const partial = new Map([...volatility(g, 1)].filter(([relPath]) => !relPath.startsWith("core/")));

    expect(judge(g, { fileVolatility: partial }).violations.map((v) => v.component)).toEqual(["core", "ports"]);
    const ungated = judge(g);
    expect(ungated.violations.map((v) => v.component)).toEqual(["core", "ports"]);
    expect(ungated.violations[0]).not.toHaveProperty("volatility");
    expect(ungated.summary.volatility).toBeUndefined();
    expect(ungated.summary.excluded.stableConcreteCalm).toBe(0);
  });
});
