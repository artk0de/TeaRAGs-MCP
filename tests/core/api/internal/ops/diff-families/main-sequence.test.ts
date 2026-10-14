/**
 * The diff-scoped `mainSequence` family's k (bd tea-rags-mcp-zuwvv): the
 * report's Ce (`buildComponentGraph`) counts DISTINCT source files with at
 * least one cross-component edge, so the diff moves a component's Ce by the
 * number of its files the diff makes efferent for the FIRST time — never by
 * its count of new file edges. A file whose pre-change targets (diff base,
 * else the index) already reached another component is counted already;
 * foundation targets count like any other (Martin's I counts them); a missing
 * pre-change fact counts the file.
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
  type DiffDetectorCatalog,
  type DiffDetectorFindings,
  type DiffDetectorGraphReader,
} from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import type { FileDependencyGraph } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { DiffDetectorFinding } from "../../../../../../src/core/contracts/types/diff-detector-finding.js";
import { buildComponentGraph } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

/** `app` sits on the main sequence at Ca 8, Ce 1 — one newly efferent file moves I 1/9 -> 2/10, past the flap tolerance. */
const APP_FACT: ComponentFact = {
  name: "app",
  instability: 1 / 9,
  distanceFromMainSequence: 0,
  connectionCount: 9,
  afferentCount: 8,
  efferentCount: 1,
};
const LIB_FACT: ComponentFact = { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 24 };
const CONTRACTS_FACT: ComponentFact = {
  name: "contracts",
  instability: 0,
  distanceFromMainSequence: 0,
  connectionCount: 30,
};

function appCatalog(appFact: ComponentFact = APP_FACT): DiffDetectorCatalog {
  return catalogOf(
    new Map<string, ComponentFact>([
      ["src/app/a.ts", appFact],
      ["src/app/b.ts", appFact],
      ["src/lib/l.ts", LIB_FACT],
      ["src/lib/m.ts", LIB_FACT],
      ["src/contracts/t.ts", CONTRACTS_FACT],
      ["src/contracts/u.ts", CONTRACTS_FACT],
    ]),
    new Map(),
    new Set(["src/contracts/t.ts", "src/contracts/u.ts"]),
  );
}

function run(
  deps: { graph?: DiffDetectorGraphReader; baseEdges?: DiffDetectorBaseEdgeReader; catalog?: DiffDetectorCatalog },
  changedFiles: readonly string[],
  overlayEdges: readonly FixtureEdge[],
): DiffDetectorFindings {
  return new DiffDetectorRun({
    ...(deps.graph !== undefined ? { graph: deps.graph } : {}),
    ...(deps.baseEdges !== undefined ? { baseEdges: deps.baseEdges } : {}),
    catalog: deps.catalog ?? appCatalog(),
  }).run({ changedFiles }, overlayOf(overlayEdges, changedFiles));
}

function mainSequenceOf(result: DiffDetectorFindings): DiffDetectorFinding | undefined {
  return result.findings.find((finding) => finding.detector === "mainSequence");
}

describe("mainSequence k = newly efferent files (bd tea-rags-mcp-zuwvv)", () => {
  it("counts a previously internal file once however many cross-component edges the diff gives it", () => {
    const result = run(
      { graph: graphOf([]), baseEdges: baseEdgesOf({ "src/app/a.ts": ["src/app/b.ts"] }) },
      ["src/app/a.ts"],
      [
        ["src/app/a.ts", "src/app/b.ts"],
        ["src/app/a.ts", "src/lib/l.ts"],
        ["src/app/a.ts", "src/lib/m.ts"],
        ["src/app/a.ts", "src/contracts/t.ts"],
      ],
    );
    const finding = mainSequenceOf(result);
    // I 1/9 -> (1+1)/(8+1+1) = 0.2, never (1+3)/(8+1+3).
    expect(finding?.evidence).toMatchObject({
      instabilityBefore: 0.111,
      instabilityAfter: 0.2,
      fanCounts: { afferentCount: 8, efferentCount: 1, newlyEfferentFileCount: 1 },
    });
    // Every contributing edge stays on the evidence.
    expect((finding?.evidence as { edges: unknown[] }).edges).toHaveLength(3);
  });

  it("emits no finding when every source already reached another component before the change — the report's Ce does not move", () => {
    const result = run(
      { graph: graphOf([]), baseEdges: baseEdgesOf({ "src/app/a.ts": ["src/lib/l.ts"] }) },
      ["src/app/a.ts"],
      [
        ["src/app/a.ts", "src/lib/l.ts"],
        ["src/app/a.ts", "src/lib/m.ts"],
        ["src/app/a.ts", "src/contracts/t.ts"],
      ],
    );
    expect(mainSequenceOf(result)).toBeUndefined();
    expect(result.detectors.find((row) => row.detector === "mainSequence")).toMatchObject({ findingCount: 0 });
    expect(result.detectors.find((row) => row.detector === "mainSequence")).not.toHaveProperty("excludedFlapCount");
  });

  it("does not exclude foundation targets: a first edge into the foundation counts the file, and a prior foundation edge already made it efferent", () => {
    const first = run(
      { graph: graphOf([]), baseEdges: baseEdgesOf({ "src/app/a.ts": [] }) },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/contracts/t.ts"]],
    );
    expect(mainSequenceOf(first)?.evidence).toMatchObject({
      fanCounts: { newlyEfferentFileCount: 1 },
      instabilityAfter: 0.2,
    });
    expect(mainSequenceOf(first)?.foundationTerminal).toBe(true);

    const already = run(
      { graph: graphOf([]), baseEdges: baseEdgesOf({ "src/app/a.ts": ["src/contracts/u.ts"] }) },
      ["src/app/a.ts"],
      [
        ["src/app/a.ts", "src/contracts/u.ts"],
        ["src/app/a.ts", "src/lib/l.ts"],
      ],
    );
    expect(mainSequenceOf(already)).toBeUndefined();
  });

  it("reads the index for a source the base does not answer for, and counts the file when neither port answers", () => {
    const indexed = run(
      { graph: graphOf([["src/app/a.ts", "src/lib/l.ts"]]) },
      ["src/app/a.ts"],
      [
        ["src/app/a.ts", "src/lib/l.ts"],
        ["src/app/a.ts", "src/lib/m.ts"],
      ],
    );
    expect(mainSequenceOf(indexed)).toBeUndefined();

    const unknown = run({}, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/m.ts"]]);
    expect(mainSequenceOf(unknown)?.evidence).toMatchObject({ fanCounts: { newlyEfferentFileCount: 1 } });
  });

  it("feeds the same k to the +1 fallback when the catalog serves no fan counts", () => {
    const noFans: ComponentFact = { name: "app", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 10 };
    const newlyEfferent = run(
      {
        graph: graphOf([]),
        baseEdges: baseEdgesOf({ "src/app/a.ts": [], "src/app/b.ts": ["src/lib/l.ts"] }),
        catalog: appCatalog(noFans),
      },
      ["src/app/a.ts", "src/app/b.ts"],
      [
        ["src/app/a.ts", "src/lib/l.ts"],
        ["src/app/a.ts", "src/lib/m.ts"],
        ["src/app/b.ts", "src/lib/l.ts"],
        ["src/app/b.ts", "src/lib/m.ts"],
      ],
    );
    // k = 1 (a only): I 0.2 -> min(1, 0.2 + 1) = 1 — the step is per file, and b, already efferent, adds nothing.
    expect(mainSequenceOf(newlyEfferent)?.evidence).toMatchObject({ instabilityAfter: 1 });
    expect(mainSequenceOf(newlyEfferent)?.detail).toContain("1 newly efferent file(s)");

    const none = run(
      { graph: graphOf([]), baseEdges: baseEdgesOf({ "src/app/b.ts": ["src/lib/l.ts"] }), catalog: appCatalog(noFans) },
      ["src/app/b.ts"],
      [
        ["src/app/b.ts", "src/lib/l.ts"],
        ["src/app/b.ts", "src/lib/m.ts"],
      ],
    );
    expect(mainSequenceOf(none)).toBeUndefined();
  });

  it("emits no finding for five new imports from a file that already imported another component (the aliases.ts -> contracts case)", () => {
    const qdrant: ComponentFact = {
      name: "src/core/adapters/qdrant",
      instability: 16 / 93,
      distanceFromMainSequence: 0,
      connectionCount: 93,
      afferentCount: 77,
      efferentCount: 16,
    };
    const contracts: ComponentFact = {
      name: "src/core/contracts",
      instability: 0,
      distanceFromMainSequence: 0,
      connectionCount: 300,
    };
    const primitives: ComponentFact = {
      name: "src/core/primitives/ids",
      instability: 0.1,
      distanceFromMainSequence: 0,
      connectionCount: 80,
    };
    const aliases = "src/core/adapters/qdrant/aliases.ts";
    const contractsFiles = [
      "src/core/contracts/signal-utils.ts",
      "src/core/contracts/types/registry.ts",
      "src/core/contracts/types/codegraph-spill.ts",
      "src/core/contracts/worktree-seed-report.ts",
      "src/core/contracts/constants.ts",
      "src/core/contracts/types/collection-identity.ts",
    ];
    const catalog = catalogOf(
      new Map<string, ComponentFact>([
        [aliases, qdrant],
        ["src/core/adapters/qdrant/connection.ts", qdrant],
        ["src/core/primitives/ids/index.ts", primitives],
        ...contractsFiles.map((relPath): [string, ComponentFact] => [relPath, contracts]),
      ]),
      new Map(),
      new Set(contractsFiles),
    );
    const before = [
      "src/core/contracts/types/collection-identity.ts",
      "src/core/primitives/ids/index.ts",
      "src/core/adapters/qdrant/connection.ts",
    ];
    const result = run(
      {
        graph: graphOf(before.map((target): FixtureEdge => [aliases, target])),
        baseEdges: baseEdgesOf({ [aliases]: before }),
        catalog,
      },
      [aliases],
      [...before, ...contractsFiles.slice(0, 5)].map((target): FixtureEdge => [aliases, target]),
    );
    expect(mainSequenceOf(result)).toBeUndefined();
  });
});

describe("mainSequence parity with the report's component graph (bd tea-rags-mcp-zuwvv)", () => {
  /** Before the change: app/a already efferent, app/b and app/c internal; eight outside files lean on app. */
  const files = [
    "src/app/a.ts",
    "src/app/b.ts",
    "src/app/c.ts",
    "src/lib/l.ts",
    "src/lib/m.ts",
    "src/contracts/t.ts",
    ...Array.from({ length: 8 }, (_, index) => `src/ext/e${index}.ts`),
  ];
  const beforeEdges: FixtureEdge[] = [
    ["src/app/a.ts", "src/lib/l.ts"],
    ["src/app/b.ts", "src/app/c.ts"],
    ...Array.from({ length: 8 }, (_, index): FixtureEdge => [`src/ext/e${index}.ts`, "src/app/a.ts"]),
  ];
  const addedEdges: FixtureEdge[] = [
    ["src/app/a.ts", "src/lib/m.ts"],
    ["src/app/a.ts", "src/contracts/t.ts"],
    ["src/app/b.ts", "src/lib/l.ts"],
    ["src/app/b.ts", "src/contracts/t.ts"],
    ["src/app/c.ts", "src/app/b.ts"],
  ];

  function dependencyGraph(edges: readonly FixtureEdge[]): FileDependencyGraph {
    return {
      files: files.map((relPath) => ({ relPath, language: "typescript", symbolCount: 1 })),
      edges: edges.map(([sourceRelPath, targetRelPath]) => ({ sourceRelPath, targetRelPath, callWeight: 1 })),
    };
  }

  it("moves the component's Ce exactly as buildComponentGraph does over the overlaid graph", () => {
    const reportBefore = buildComponentGraph(dependencyGraph(beforeEdges), []);
    const reportAfter = buildComponentGraph(dependencyGraph([...beforeEdges, ...addedEdges]), []);
    const catalog = catalogOf(
      new Map(
        files.map((relPath): [string, ComponentFact] => {
          const name = reportBefore.componentOf.get(relPath) ?? "";
          const component = reportBefore.components.get(name);
          if (component === undefined) throw new Error(`fixture: no component for ${relPath}`);
          return [
            relPath,
            {
              name,
              instability: component.instability,
              distanceFromMainSequence: 0,
              connectionCount: component.connectionCount,
              afferentCount: component.afferentCount,
              efferentCount: component.efferentCount,
            },
          ];
        }),
      ),
    );
    const changed = ["src/app/a.ts", "src/app/b.ts", "src/app/c.ts"];
    const overlay = [...beforeEdges, ...addedEdges].filter(([source]) => changed.includes(source));
    const result = run({ graph: graphOf(beforeEdges), catalog }, changed, overlay);

    const appBefore = reportBefore.components.get("src/app");
    const appAfter = reportAfter.components.get("src/app");
    const finding = mainSequenceOf(result);
    expect(finding?.evidence).toMatchObject({
      fanCounts: {
        afferentCount: appBefore?.afferentCount,
        efferentCount: appBefore?.efferentCount,
        newlyEfferentFileCount: (appAfter?.efferentCount ?? 0) - (appBefore?.efferentCount ?? 0),
      },
      instabilityAfter: Math.round((appAfter?.instability ?? 0) * 1000) / 1000,
    });
    expect(appAfter?.efferentCount).toBe(2);
  });
});
