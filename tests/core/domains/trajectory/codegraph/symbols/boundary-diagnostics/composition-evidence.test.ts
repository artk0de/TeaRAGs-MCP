/**
 * Measured composition evidence on SDP and hub findings (bd
 * tea-rags-mcp-r8hme.52.17). Owner decision 2026-10-14: ANNOTATE, never
 * exclude (r8hme.51 stands) — the flags are triage evidence, the findings stay
 * counted.
 *
 * - `compositionTable`: a FILE whose every dependency edge carries no call
 *   (registration / table wiring) and that fans out to an outlier number of
 *   distinct components — each file's count − 1 tested against a geometric
 *   null fitted to the population's mean, Benjamini–Hochberg at the
 *   conventional q over the population; too small a population flags no
 *   file.
 * - `parentSurface`: a COMPONENT whose afferent files mostly sit outside its
 *   parent namespace / directory while its efferent targets mostly sit inside
 *   it — the parent's surface onto its own internals.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  detectComponentStableDependencyViolations,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(sourceRelPath: string, targetRelPath: string, callWeight = 1): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight };
}

/**
 * `registry/table.ts` wires `c1`..`c8` with no call (8 distinct components);
 * `plain1`..`plain10` each wire `c1` with no call (1 component) — the typical
 * callWeight-0 file. `app/` (6 files) calls into the registry, so the registry
 * is stable (Ca 6, Ce 1); every `cK/` holds 4 files calling `vendor/`, so
 * `c2`..`c8` are unstable (Ca 1, Ce 4) and registry → cK breaks SDP.
 */
function registryWiringGraph(plainFileCount = 10): FileDependencyGraph {
  const files = [file("registry/table.ts"), file("vendor/v.ts")];
  const edges: FileDependencyEdge[] = [];
  for (let k = 1; k <= 8; k++) {
    files.push(file(`c${k}/x.ts`));
    edges.push(edge("registry/table.ts", `c${k}/x.ts`, 0));
    for (let j = 1; j <= 4; j++) {
      files.push(file(`c${k}/y${j}.ts`));
      edges.push(edge(`c${k}/y${j}.ts`, "vendor/v.ts"));
    }
  }
  for (let p = 1; p <= plainFileCount; p++) {
    files.push(file(`plain${p}/p.ts`));
    edges.push(edge(`plain${p}/p.ts`, "c1/x.ts", 0));
  }
  for (let a = 1; a <= 6; a++) {
    files.push(file(`app/a${a}.ts`));
    edges.push(edge(`app/a${a}.ts`, "registry/table.ts"));
  }
  return { files, edges };
}

describe("compositionTable — a callWeight-0 file fanning out to an outlier number of components", () => {
  it("flags the outlier wiring file and reports the significance cut it was judged by", () => {
    const tables = buildComponentGraph(registryWiringGraph(), []).compositionTables;

    expect([...(tables?.files ?? [])]).toEqual(["registry/table.ts"]);
    expect(tables?.cut).toMatchObject({
      thresholdMethod: "geometricTailBH",
      q: 0.05,
      median: 1,
      population: 11,
      testedCount: 1,
      fileCount: 1,
    });
    expect(tables?.cut.nullMean).toBeCloseTo(7 / 11, 12);
  });

  it("leaves a callWeight-0 file with a typical fan-out unflagged", () => {
    const tables = buildComponentGraph(registryWiringGraph(), []).compositionTables;

    expect(tables?.files.has("plain1/p.ts")).toBe(false);
  });

  it("leaves a file with any calling edge out of the population", () => {
    const g = registryWiringGraph();
    g.edges.push(edge("registry/table.ts", "vendor/v.ts", 1));
    const tables = buildComponentGraph(g, []).compositionTables;

    expect(tables?.files.size).toBe(0);
    expect(tables?.cut.population).toBe(10);
  });

  it("flags no file when the population is too small for the cut to be trusted", () => {
    const tables = buildComponentGraph(registryWiringGraph(2), []).compositionTables;

    expect(tables?.files.size).toBe(0);
    expect(tables?.cut).toMatchObject({ thresholdMethod: "none", population: 3, fileCount: 0 });
  });

  it("annotates the SDP violations the table carries — still counted, never excluded", () => {
    const report = detectComponentStableDependencyViolations(buildComponentGraph(registryWiringGraph(), []));

    const fromRegistry = report.violations.filter((v) => v.sourceComponent === "registry");
    expect(fromRegistry).toHaveLength(7);
    expect(fromRegistry.every((v) => v.compositionTable === true)).toBe(true);
    expect(report.summary.violationCount).toBe(report.violations.length);
    expect(report.summary.compositionTableCut).toMatchObject({ thresholdMethod: "geometricTailBH", fileCount: 1 });
  });

  it("leaves the flag absent on a violation one calling file carries", () => {
    const g = registryWiringGraph();
    g.files.push(file("registry/caller.ts"));
    g.edges.push(edge("registry/caller.ts", "c2/x.ts", 3));
    const report = detectComponentStableDependencyViolations(buildComponentGraph(g, []));

    const toC2 = report.violations.find((v) => v.sourceComponent === "registry" && v.targetComponent === "c2");
    expect(toC2).toBeDefined();
    expect("compositionTable" in (toC2 ?? {})).toBe(false);
  });
});

/**
 * callWeight-0 files `t<i>/f.ts`, file i wiring `fanOuts[i]` distinct
 * components `c1`..`cK` (each `cK/x.ts` calls `vendor/`, so it is never in the
 * population itself).
 */
function fanOutGraph(fanOuts: readonly number[]): FileDependencyGraph {
  const maxFanOut = Math.max(...fanOuts);
  const files = [file("vendor/v.ts")];
  const edges: FileDependencyEdge[] = [];
  for (let k = 1; k <= maxFanOut; k++) {
    files.push(file(`c${k}/x.ts`));
    edges.push(edge(`c${k}/x.ts`, "vendor/v.ts"));
  }
  fanOuts.forEach((fanOut, i) => {
    files.push(file(`t${i}/f.ts`));
    for (let k = 1; k <= fanOut; k++) edges.push(edge(`t${i}/f.ts`, `c${k}/x.ts`, 0));
  });
  return { files, edges };
}

describe("compositionTable cut — geometric null on count − 1, BH over the population", () => {
  it("flags only the far tail of a point mass at 1 with a heavy tail", () => {
    const fanOuts = [...Array<number>(40).fill(1), ...Array<number>(5).fill(2), 3, 3, 12];
    const tables = buildComponentGraph(fanOutGraph(fanOuts), []).compositionTables;

    expect([...(tables?.files ?? [])]).toEqual([`t${fanOuts.length - 1}/f.ts`]);
    expect(tables?.cut).toMatchObject({
      thresholdMethod: "geometricTailBH",
      population: 48,
      testedCount: 8,
      fileCount: 1,
    });
  });

  it("flags nothing when the counts are uniformly small", () => {
    const fanOuts = Array.from({ length: 30 }, (_, i) => 1 + (i % 3));
    const tables = buildComponentGraph(fanOutGraph(fanOuts), []).compositionTables;

    expect(tables?.files.size).toBe(0);
    expect(tables?.cut).toMatchObject({ thresholdMethod: "geometricTailBH", population: 30, fileCount: 0 });
  });

  it("flags nothing when every file wires a single component — no excess to test", () => {
    const tables = buildComponentGraph(fanOutGraph(Array<number>(20).fill(1)), []).compositionTables;

    expect(tables?.files.size).toBe(0);
    expect(tables?.cut).toMatchObject({ testedCount: 0, fileCount: 0, nullMean: 0 });
  });

  it("does not run the test on a population below the minimum", () => {
    const tables = buildComponentGraph(fanOutGraph([1, 1, 1, 12]), []).compositionTables;

    expect(tables?.files.size).toBe(0);
    expect(tables?.cut).toEqual({ thresholdMethod: "none", median: 1, population: 4, fileCount: 0 });
  });
});

/**
 * `billing/api/` (2 files) calls `billing/ledger.ts` and `billing/invoice.ts`
 * — its parent's internals; its 3 dependents live under `afferentDir`.
 * `billing/` also holds 3 files calling `vendor/`: Ca 2, Ce 5 → I 0.71, so
 * billing/api (Ca 3, Ce 2 → I 0.4) → billing breaks SDP.
 */
function domainApiGraph(afferentDir: string): FileDependencyGraph {
  const files = [
    file("billing/api/a1.ts"),
    file("billing/api/a2.ts"),
    file("billing/ledger.ts"),
    file("billing/invoice.ts"),
    file("vendor/v.ts"),
  ];
  const edges: FileDependencyEdge[] = [];
  for (const api of ["billing/api/a1.ts", "billing/api/a2.ts"]) {
    edges.push(edge(api, "billing/ledger.ts"), edge(api, "billing/invoice.ts"));
  }
  edges.push(edge("billing/ledger.ts", "vendor/v.ts"), edge("billing/invoice.ts", "vendor/v.ts"));
  for (let j = 1; j <= 3; j++) {
    files.push(file(`billing/j${j}.ts`));
    edges.push(edge(`billing/j${j}.ts`, "vendor/v.ts"));
  }
  for (let w = 1; w <= 3; w++) {
    files.push(file(`${afferentDir}/w${w}.ts`));
    edges.push(edge(`${afferentDir}/w${w}.ts`, "billing/api/a1.ts"));
  }
  return { files, edges };
}

describe("parentSurface — a component used from outside its parent, using its parent's internals", () => {
  it("flags the directory component whose dependents are outside the parent and whose targets are inside it", () => {
    const { components } = buildComponentGraph(domainApiGraph("web"), []);

    expect(components.get("billing/api")?.parentSurface).toBe(true);
  });

  it("leaves a component whose dependents come from inside its parent unflagged", () => {
    const { components } = buildComponentGraph(domainApiGraph("billing/web"), []);

    expect("parentSurface" in (components.get("billing/api") ?? {})).toBe(false);
  });

  it("leaves a top-level component unflagged — it has no parent to be the surface of", () => {
    const { components } = buildComponentGraph(domainApiGraph("web"), []);

    expect("parentSurface" in (components.get("web") ?? {})).toBe(false);
    expect("parentSurface" in (components.get("billing") ?? {})).toBe(false);
  });

  it("reads a namespace component's parent by constant path", () => {
    const relabel = new Map([
      ["billing/api/a1.ts", "::Billing::Api"],
      ["billing/api/a2.ts", "::Billing::Api"],
      ["billing/ledger.ts", "::Billing"],
      ["billing/invoice.ts", "::Billing"],
      ["web/w1.ts", "::Web"],
      ["web/w2.ts", "::Web"],
      ["web/w3.ts", "::Web"],
    ]);
    const { components } = buildComponentGraph(domainApiGraph("web"), [], relabel);

    expect(components.get("::Billing::Api")?.parentSurface).toBe(true);
  });

  it("annotates the SDP violation the surface sources — still counted, never excluded", () => {
    const report = detectComponentStableDependencyViolations(buildComponentGraph(domainApiGraph("web"), []));

    const violation = report.violations.find((v) => v.sourceComponent === "billing/api");
    expect(violation).toMatchObject({ targetComponent: "billing", parentSurface: true });
    expect(report.summary.violationCount).toBe(report.violations.length);
  });
});
