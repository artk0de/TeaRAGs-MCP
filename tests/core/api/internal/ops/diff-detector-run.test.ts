/**
 * `DiffDetectorRun` — the diff-scoped detector judgement layer (bd
 * tea-rags-mcp-89k7k.1.3, F2): one working-tree change's overlay edges judged
 * against report-derived facts delivered through injected ports. Every fixture
 * here is a plain Map — no DuckDB, no temp repositories, no index: the layer
 * is pure by contract, so its tests are pure by construction. The real
 * `ReviewEdgeOverlay` (itself pure) is the one production class exercised.
 */
import { describe, expect, it } from "vitest";

import {
  DiffDetectorRun,
  type DiffDetectorContractReader,
  type DiffDetectorFindings,
  type DiffDetectorSilentCouplingFacts,
  type DiffDetectorSplitMergeReader,
} from "../../../../../src/core/api/internal/ops/diff-detector-run.js";
import type { DiffDetectorFinding } from "../../../../../src/core/contracts/types/diff-detector-finding.js";
import { ReviewEdgeOverlay } from "../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";
import type { SplitMergeVerdicts } from "../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";
import {
  baseEdgesOf,
  catalogOf,
  graphOf,
  overlayOf,
  runWith,
  type ComponentFact,
} from "./__helpers__/diff-run-fixtures.js";

/**
 * A file edge plus the export names its statements recorded — the fixture
 * shape `facadeContract` judges (the tree's re-export surface lives on the
 * overlay's own edges, bd tea-rags-mcp-89k7k.1.6).
 */
type FixtureNamedEdge = readonly [
  source: string,
  target: string,
  names: { imported?: readonly string[]; reexported?: readonly string[] },
];

/** The measured layering foundation the report would name for these fixtures' contracts file. */
const CONTRACTS_FOUNDATION = new Set(["src/core/contracts/types/x.ts"]);

/**
 * The production silent-coupling verdict as a hand-built port: violations are
 * the detector's OUTPUT (precomputed by the wiring), so tests construct them
 * directly — every entry is already strong, unlinked and unexplained per the
 * production gates.
 */
function factsOf(
  violations: readonly { relPathA: string; relPathB: string; support: number; strength: number }[],
  excluded: Partial<
    Record<
      | "testEndpoints"
      | "generatedEndpoints"
      | "documentationEndpoints"
      | "unwalkedEndpoints"
      | "notSignificant"
      | "explainedByFacadeChain",
      number
    >
  > = {},
): DiffDetectorSilentCouplingFacts {
  return {
    violations,
    excluded: {
      testEndpoints: 0,
      generatedEndpoints: 0,
      documentationEndpoints: 0,
      unwalkedEndpoints: 0,
      notSignificant: 0,
      explainedByFacadeChain: 0,
      ...excluded,
    },
  };
}

/** Facade-contract facts the way the port serves them: facades by component, consumers by facade. */
/**
 * The contract port. `surfaces` is each facade's INDEXED re-export surface;
 * unset, it defaults to every name the facade's consumers import — the
 * realistic pre-diff state, where what consumers import the facade exported.
 */
function contractOf(
  facades: ReadonlyMap<string, string>,
  consumers: ReadonlyMap<string, readonly { source: string; importedNames?: string[] }[]>,
  surfaces?: ReadonlyMap<string, readonly string[] | undefined>,
): DiffDetectorContractReader {
  return {
    facadeComponentOf: (relPath) => facades.get(relPath),
    indexedConsumersOf: (facade) => consumers.get(facade) ?? [],
    indexedSurfaceOf: (facade) =>
      surfaces !== undefined
        ? surfaces.get(facade)
        : [...new Set((consumers.get(facade) ?? []).flatMap((consumer) => consumer.importedNames ?? []))],
  };
}

/**
 * The phase-1 verdicts as a hand-built port: the verdicts are the layer's
 * INPUT (precomputed by the wiring), so tests construct them directly — every
 * entry of `splitCandidates` / `mergeCandidates` is already admitted.
 */
function splitMergeOf(
  verdicts: Partial<SplitMergeVerdicts>,
  components: ReadonlyMap<string, string>,
): DiffDetectorSplitMergeReader {
  return {
    verdicts: {
      splitCandidates: [],
      mergeCandidates: [],
      threshold: 0.5,
      thresholdMethod: "majority",
      excluded: { unpartitionedEndpoints: 0, crossComponentPairs: 0 },
      ...verdicts,
    },
    componentOf: (relPath) => components.get(relPath),
  };
}

/** Subjects of one detector's findings, in emission order. */
function subjectsOf(result: DiffDetectorFindings, detector: DiffDetectorFinding["detector"]): string[] {
  return result.findings.filter((finding) => finding.detector === detector).map((finding) => finding.subject);
}

/** The review's overlay with name-carrying edges: one read per changed file, its edges picked from the tuples. */
function namedOverlayOf(edges: readonly FixtureNamedEdge[], changed: readonly string[]): ReviewEdgeOverlay {
  return new ReviewEdgeOverlay(
    changed.map((relPath) => ({
      relPath,
      edges: Object.freeze(
        edges
          .filter(([source]) => source === relPath)
          .map(([sourceRelPath, targetRelPath, names]) => ({
            sourceRelPath,
            targetRelPath,
            ...(names.imported !== undefined ? { importedExportNames: [...names.imported] } : {}),
            ...(names.reexported !== undefined ? { reexportedExportNames: [...names.reexported] } : {}),
          })),
      ),
    })),
  );
}

/** One judged run over name-carrying overlay edges, with only the contract port injected. */
function runWithContract(
  contract: DiffDetectorContractReader | undefined,
  changedFiles: readonly string[],
  overlayEdges: readonly FixtureNamedEdge[],
): DiffDetectorFindings {
  const run = new DiffDetectorRun({
    graph: graphOf([]),
    catalog: catalogOf(new Map()),
    ...(contract !== undefined ? { contract } : {}),
  });
  return run.run({ changedFiles }, namedOverlayOf(overlayEdges, changedFiles));
}

describe("stableDependencies", () => {
  const components = new Map([
    ["src/app/a.ts", { name: "app", instability: 0.2, distanceFromMainSequence: 0.4 }],
    ["src/lib/b.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2 }],
  ]);

  it("fires on an overlay edge leaning on the markedly-less-stable side", () => {
    const result = runWith({ catalog: catalogOf(components) }, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/b.ts"]]);
    expect(subjectsOf(result, "stableDependencies")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    const finding = result.findings[0];
    // Structured endpoints (bd tea-rags-mcp-r8hme.44): the judged component
    // pair the whole-repo SDP violation keys on, plus the file edge carrying it.
    expect(finding?.endpoints).toEqual({
      kind: "componentEdge",
      sourceComponent: "app",
      targetComponent: "lib",
      sourceRelPath: "src/app/a.ts",
      targetRelPath: "src/lib/b.ts",
    });
    expect(finding?.evidence).toEqual({ sourceInstability: 0.2, targetInstability: 0.9 });
    expect(finding?.detail).toContain("markedly");
  });

  it("stays silent below the predicate's band", () => {
    const balanced = new Map([
      ["src/app/a.ts", { name: "app", instability: 0.5, distanceFromMainSequence: 0.3 }],
      ["src/lib/b.ts", { name: "lib", instability: 0.6, distanceFromMainSequence: 0.3 }],
    ]);
    const result = runWith({ catalog: catalogOf(balanced) }, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/b.ts"]]);
    expect(subjectsOf(result, "stableDependencies")).toEqual([]);
  });

  it("skips silently when an end maps to no component", () => {
    const half = new Map([["src/app/a.ts", components.get("src/app/a.ts")!]]);
    const result = runWith({ catalog: catalogOf(half) }, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/b.ts"]]);
    expect(result.findings).toEqual([]);
  });

  it("reports an edge pair once even when the scope lists the file twice", () => {
    const result = runWith(
      { catalog: catalogOf(components) },
      ["src/app/a.ts", "src/app/a.ts"],
      [["src/app/a.ts", "src/lib/b.ts"]],
    );
    expect(subjectsOf(result, "stableDependencies")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
  });

  // bd tea-rags-mcp-hbceb (parity with the whole-repo detector's
  // tea-rags-mcp-r8hme.51): the composition root assembles unstable
  // concretes — that is its JOB — so an SDP finding sourced from a root
  // carries the annotation as triage data, never a suppression. Since bd
  // tea-rags-mcp-r8hme.52.4 the root is the MEASURED one the catalog serves
  // (`entryFacade`: the component holds a facade nothing imports); the
  // declared path list is retired, so a former declared dir carries nothing.
  it("stamps compositionRoot: true on a finding whose source component holds an entry facade", () => {
    const rootOnVolatile = new Map<string, ComponentFact>([
      [
        "root/main.ts",
        { name: "root", instability: 0.2, distanceFromMainSequence: 0.4, connectionCount: 10, entryFacade: true },
      ],
      ["src/lib/b.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2, connectionCount: 10 }],
    ]);
    const result = runWith(
      { catalog: catalogOf(rootOnVolatile) },
      ["root/main.ts"],
      [["root/main.ts", "src/lib/b.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "stableDependencies");
    expect(finding?.subject).toBe("root/main.ts -> src/lib/b.ts");
    expect(finding?.compositionRoot).toBe(true);
  });

  it("names no root by path: a source under the retired declared root's dir stays unannotated", () => {
    const nested = new Map([
      [
        "src/bootstrap/wiring/main.ts",
        { name: "src/bootstrap/wiring", instability: 0.2, distanceFromMainSequence: 0.4 },
      ],
      ["src/lib/b.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2 }],
    ]);
    const result = runWith(
      { catalog: catalogOf(nested) },
      ["src/bootstrap/wiring/main.ts"],
      [["src/bootstrap/wiring/main.ts", "src/lib/b.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "stableDependencies");
    expect(finding?.subject).toBe("src/bootstrap/wiring/main.ts -> src/lib/b.ts");
    expect("compositionRoot" in (finding ?? {})).toBe(false);
  });

  it("leaves a finding whose source is no declared root unannotated — and never annotates the target side", () => {
    const result = runWith({ catalog: catalogOf(components) }, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/b.ts"]]);
    const finding = result.findings.find((f) => f.detector === "stableDependencies");
    expect(finding?.subject).toBe("src/app/a.ts -> src/lib/b.ts");
    expect("compositionRoot" in (finding ?? {})).toBe(false);
  });
});

describe("leakingAbstraction", () => {
  const FACADE = "src/lib/index.ts";
  const components = new Map([
    ["src/lib/internal.ts", { name: "lib", instability: 0.3, distanceFromMainSequence: 0.3 }],
  ]);
  const facades = new Map([["lib", FACADE]]);

  it("fires when the source already imports the facade and the diff adds an internal edge", () => {
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", FACADE]]),
        catalog: catalogOf(components, facades),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/internal.ts"]],
    );
    expect(subjectsOf(result, "leakingAbstraction")).toEqual(["src/app/a.ts -> src/lib/internal.ts"]);
    expect(result.findings[0]?.endpoints).toEqual({
      kind: "fileEdge",
      sourceRelPath: "src/app/a.ts",
      targetRelPath: "src/lib/internal.ts",
    });
    expect(result.findings[0]?.evidence).toEqual({ facadeRelPath: FACADE });
  });

  it("does not fire without the pre-existing facade import", () => {
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", "src/other/c.ts"]]),
        catalog: catalogOf(components, facades),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/internal.ts"]],
    );
    expect(result.findings).toEqual([]);
  });

  it("does not fire when the overlay edge targets the facade itself", () => {
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", FACADE]]),
        catalog: catalogOf(components, facades),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", FACADE]],
    );
    expect(result.findings).toEqual([]);
  });

  it("stays silent when the target maps to no component or the component has no facade", () => {
    const noComponent = runWith(
      { catalog: catalogOf(new Map(), facades) },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/internal.ts"]],
    );
    expect(noComponent.findings).toEqual([]);

    const noFacade = runWith(
      { catalog: catalogOf(components) },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/internal.ts"]],
    );
    expect(noFacade.findings).toEqual([]);
  });
});

describe("cycles", () => {
  it("closes the path through the indexed graph and reports it as evidence", () => {
    const result = runWith(
      {
        graph: graphOf([
          ["src/b.ts", "src/c.ts"],
          ["src/c.ts", "src/a.ts"],
        ]),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/b.ts"]],
    );
    expect(subjectsOf(result, "cycles")).toEqual(["src/a.ts -> src/b.ts"]);
    expect(result.findings[0]?.endpoints).toEqual({
      kind: "fileEdge",
      sourceRelPath: "src/a.ts",
      targetRelPath: "src/b.ts",
    });
    expect(result.findings[0]?.evidence).toEqual({ path: ["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"] });
  });

  it("finds nothing when the reverse direction is unreachable", () => {
    const result = runWith({ graph: graphOf([["src/b.ts", "src/x.ts"]]) }, ["src/a.ts"], [["src/a.ts", "src/b.ts"]]);
    expect(result.findings).toEqual([]);
  });

  it("respects the hop cap, boundary included", () => {
    const graph = graphOf([
      ["src/b.ts", "src/c.ts"],
      ["src/c.ts", "src/d.ts"],
      ["src/d.ts", "src/a.ts"],
    ]);
    const within = runWith({ graph, maxTraceHops: 3 }, ["src/a.ts"], [["src/a.ts", "src/b.ts"]]);
    expect(subjectsOf(within, "cycles")).toEqual(["src/a.ts -> src/b.ts"]);

    const beyond = runWith({ graph, maxTraceHops: 2 }, ["src/a.ts"], [["src/a.ts", "src/b.ts"]]);
    expect(beyond.findings).toEqual([]);
  });

  it("does not traverse a changed file's indexed edges — a cycle existing only through one is not reported", () => {
    const graph = graphOf([
      ["src/b.ts", "src/m.ts"],
      ["src/m.ts", "src/a.ts"],
    ]);
    const masked = runWith({ graph }, ["src/a.ts", "src/m.ts"], [["src/a.ts", "src/b.ts"]]);
    expect(masked.findings).toEqual([]);

    const unmasked = runWith({ graph }, ["src/a.ts"], [["src/a.ts", "src/b.ts"]]);
    expect(unmasked.findings[0]?.evidence).toEqual({ path: ["src/a.ts", "src/b.ts", "src/m.ts", "src/a.ts"] });
  });
});

describe("mainSequence", () => {
  const components = new Map([
    ["src/app/a.ts", { name: "app", instability: 0.5, distanceFromMainSequence: 0.3 }],
    ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1 }],
    ["src/orphan/o.ts", { name: "orphan", instability: 0.9, distanceFromMainSequence: 0.5 }],
  ]);

  it("reports only the touched component, with its D delta and the edges that moved it", () => {
    const result = runWith({ catalog: catalogOf(components) }, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/b.ts"]]);
    expect(subjectsOf(result, "mainSequence")).toEqual(["app"]);
    const finding = result.findings[0];
    // I 0.5 -> 1.0 with A held at 1 - I + D = 0.8: D moves 0.3 -> 0.8.
    expect(finding?.endpoints).toEqual({ kind: "component", component: "app" });
    expect(finding?.evidence).toMatchObject({ distanceBefore: 0.3, distanceAfter: 0.8 });
    expect(finding?.evidence).toMatchObject({
      edges: [{ sourceRelPath: "src/app/a.ts", targetRelPath: "src/lib/b.ts" }],
    });
  });

  it("never lists the components no changed file belongs to", () => {
    const result = runWith({ catalog: catalogOf(components) }, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/b.ts"]]);
    const subjects = subjectsOf(result, "mainSequence");
    expect(subjects).not.toContain("lib");
    expect(subjects).not.toContain("orphan");
  });

  it("stays below the epsilon when the component is already maximally unstable", () => {
    const saturated = new Map(components);
    saturated.set("src/hot/s.ts", { name: "hot", instability: 1, distanceFromMainSequence: 0.2 });
    const result = runWith({ catalog: catalogOf(saturated) }, ["src/hot/s.ts"], [["src/hot/s.ts", "src/lib/b.ts"]]);
    expect(subjectsOf(result, "mainSequence")).toEqual([]);
  });

  // bd tea-rags-mcp-r8hme.45 (a): a component whose whole coupling is a couple
  // of edges reads instability in steps of 1/n — at connectionCount 1 a single
  // edge moves it by the full scale, so the diff's +1-per-edge approximation
  // reads every small component as saturated. The whole-repo detector excludes
  // such components (`summary.mainSequence.excluded.lowConnectionCount`); the
  // diff-scoped judgement honors the same SDP floor, and COUNTS the exclusion
  // on its family row — a zero over below-floor components is not a clean pass.
  it("excludes a touched component below the SDP connection floor — one edge swings its instability by half the scale", () => {
    const smallN = new Map<string, ComponentFact>([
      ["src/tiny/t.ts", { name: "tiny", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 1 }],
      ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 8 }],
    ]);
    const result = runWith({ catalog: catalogOf(smallN) }, ["src/tiny/t.ts"], [["src/tiny/t.ts", "src/lib/b.ts"]]);
    expect(subjectsOf(result, "mainSequence")).toEqual([]);
    expect(result.detectors.find((d) => d.detector === "mainSequence")).toMatchObject({
      excludedLowConnectionCount: 1,
    });
  });

  it("excludes at the floor the whole-repo detector excludes at — connectionCount below DEFAULT_SDP_MIN_CONNECTION_COUNT, not at it", () => {
    const atFloor = new Map<string, ComponentFact>([
      ["src/at/a.ts", { name: "at", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 5 }],
      ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 8 }],
    ]);
    const judged = runWith({ catalog: catalogOf(atFloor) }, ["src/at/a.ts"], [["src/at/a.ts", "src/lib/b.ts"]]);
    expect(subjectsOf(judged, "mainSequence")).toEqual(["at"]);

    const below = new Map<string, ComponentFact>([
      ["src/at/a.ts", { name: "at", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 4 }],
      ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 8 }],
    ]);
    const excluded = runWith({ catalog: catalogOf(below) }, ["src/at/a.ts"], [["src/at/a.ts", "src/lib/b.ts"]]);
    expect(subjectsOf(excluded, "mainSequence")).toEqual([]);
  });

  // bd tea-rags-mcp-r8hme.45 (b): a D-delta whose every contributing edge
  // terminates inside a contracts/ directory is the legal foundation
  // direction — the lowest layer, which everything may depend on. The finding
  // stays (the distance moved), but carries the annotation as DATA so a
  // consumer triages it instead of judging blind.
  it("annotates a D-delta whose contributing edges all terminate at contracts/", () => {
    const toFoundation = new Map<string, ComponentFact>([
      ["src/app/a.ts", { name: "app", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 9 }],
      [
        "src/core/contracts/types/x.ts",
        { name: "src/core/contracts/types", instability: 0.1, distanceFromMainSequence: 0.1, connectionCount: 9 },
      ],
    ]);
    const result = runWith(
      { catalog: catalogOf(toFoundation, new Map(), CONTRACTS_FOUNDATION) },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/core/contracts/types/x.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "mainSequence");
    expect(finding?.subject).toBe("app");
    expect(finding?.foundationTerminal).toBe(true);
  });

  it("leaves an above-floor component's mixed delta judged but unannotated — one non-contracts edge is enough", () => {
    const mixed = new Map<string, ComponentFact>([
      ["src/app/a.ts", { name: "app", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 9 }],
      ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 9 }],
      [
        "src/core/contracts/types/x.ts",
        { name: "src/core/contracts/types", instability: 0.1, distanceFromMainSequence: 0.1, connectionCount: 9 },
      ],
    ]);
    const result = runWith(
      { catalog: catalogOf(mixed, new Map(), CONTRACTS_FOUNDATION) },
      ["src/app/a.ts"],
      [
        ["src/app/a.ts", "src/core/contracts/types/x.ts"],
        ["src/app/a.ts", "src/lib/b.ts"],
      ],
    );
    const finding = result.findings.find((f) => f.detector === "mainSequence");
    expect(finding?.subject).toBe("app");
    expect(finding?.foundationTerminal).toBeUndefined();
  });

  // bd tea-rags-mcp-89k7k.35.11: the foundation is the MEASURED one the
  // whole-repo layering reports in summary.foundation (abstractness 1 at L0), served
  // by the catalog — never a directory name. Both pipelines agree on it.
  it("annotates a delta into a measured foundation whatever the directory is called", () => {
    const toFoundation = new Map<string, ComponentFact>([
      ["src/app/a.ts", { name: "app", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 9 }],
      ["src/spi/port.ts", { name: "src/spi", instability: 0.1, distanceFromMainSequence: 0.1, connectionCount: 9 }],
    ]);
    const result = runWith(
      { catalog: catalogOf(toFoundation, new Map(), new Set(["src/spi/port.ts"])) },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/spi/port.ts"]],
    );
    expect(result.findings.find((f) => f.detector === "mainSequence")?.foundationTerminal).toBe(true);
  });

  it("leaves a delta into a contracts/ directory unannotated when it is not a measured foundation", () => {
    const toContracts = new Map<string, ComponentFact>([
      ["src/app/a.ts", { name: "app", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 9 }],
      [
        "src/core/contracts/types/x.ts",
        { name: "src/core/contracts/types", instability: 0.1, distanceFromMainSequence: 0.1, connectionCount: 9 },
      ],
    ]);
    const result = runWith(
      { catalog: catalogOf(toContracts) },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/core/contracts/types/x.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "mainSequence");
    expect(finding?.subject).toBe("app");
    expect(finding?.foundationTerminal).toBeUndefined();
  });

  // bd tea-rags-mcp-zh3l0 (parity with the whole-repo detector): an entry
  // component is the unstable END of the main sequence by design — nothing
  // imports the entry surface — so a diff-window D-delta on one is inherent
  // to that placement, not a placement defect. The finding carries the
  // annotation as triage data, never a suppression. Since bd
  // tea-rags-mcp-r8hme.52.4 the entry is the MEASURED one the catalog serves
  // (`entryFacade`); the declared path list is retired.
  it("stamps entryPoint: true on a D-delta whose touched component holds an entry facade", () => {
    const entry = new Map<string, ComponentFact>([
      [
        "tool/call.ts",
        { name: "tool", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 9, entryFacade: true },
      ],
      ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 9 }],
    ]);
    const result = runWith({ catalog: catalogOf(entry) }, ["tool/call.ts"], [["tool/call.ts", "src/lib/b.ts"]]);
    const finding = result.findings.find((f) => f.detector === "mainSequence");
    expect(finding?.subject).toBe("tool");
    expect(finding?.entryPoint).toBe(true);
  });

  it("names no entry by path: a component under the retired declared mcp dir stays unannotated", () => {
    const nested = new Map<string, ComponentFact>([
      [
        "src/mcp/tools/register.ts",
        { name: "src/mcp/tools", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 9 },
      ],
      ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 9 }],
    ]);
    const result = runWith(
      { catalog: catalogOf(nested) },
      ["src/mcp/tools/register.ts"],
      [["src/mcp/tools/register.ts", "src/lib/b.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "mainSequence");
    expect(finding?.subject).toBe("src/mcp/tools");
    expect("entryPoint" in (finding ?? {})).toBe(false);
  });

  it("leaves a finding whose component is no declared entry unannotated", () => {
    const result = runWith({ catalog: catalogOf(components) }, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/b.ts"]]);
    const finding = result.findings.find((f) => f.detector === "mainSequence");
    expect(finding?.subject).toBe("app");
    expect("entryPoint" in (finding ?? {})).toBe(false);
  });

  // bd tea-rags-mcp-89k7k.19: the 89k7k.14 replay residual — one GENUINELY-new
  // edge on a 24-connection low-I component (the api/public barrel class) read
  // as a full-scale instability step, D 0.000 -> 0.946, because the +1-per-edge
  // approximation had no access to the component's actual fan counts. The
  // catalog now serves Ca/Ce (the report's own ArchitectureComponent facts),
  // and the recompute is the whole-repo detector's own arithmetic applied to
  // the post-diff fan: I' = (Ce + k)/(Ca + Ce + k) over k genuinely-new
  // cross-component edges — the subtraction's output, never the re-read set.
  describe("fan-count recompute", () => {
    /** The residual's component: Ca 22, Ce 2, connectionCount 24, I = 2/24, on the sequence. */
    function lowIFanFixture(): Map<string, ComponentFact> {
      return new Map<string, ComponentFact>([
        [
          "src/api/barrel.ts",
          {
            name: "api",
            instability: 2 / 24,
            distanceFromMainSequence: 0,
            connectionCount: 24,
            afferentCount: 22,
            efferentCount: 2,
          },
        ],
        [
          "src/lib/b.ts",
          {
            name: "lib",
            instability: 0.2,
            distanceFromMainSequence: 0.1,
            connectionCount: 24,
            afferentCount: 19,
            efferentCount: 5,
          },
        ],
      ]);
    }

    it("recomputes I' from the served fan counts — one genuinely-new edge on a 24-connection component moves D by (Ce+1)/(Ca+Ce+1), not a full-scale step", () => {
      const result = runWith(
        { catalog: catalogOf(lowIFanFixture()) },
        ["src/api/barrel.ts"],
        [["src/api/barrel.ts", "src/lib/b.ts"]],
      );
      expect(subjectsOf(result, "mainSequence")).toEqual(["api"]);
      const finding = result.findings.find((f) => f.detector === "mainSequence");
      // I 2/24 -> 3/25 with A held at 1 - 2/24 = 22/24: D moves 0 -> 22/24 + 3/25 - 1 = 0.0367.
      // Under the +1-per-edge step this saturated to I=1.000, D 0.917 — the residual class.
      expect(finding?.evidence).toMatchObject({
        distanceBefore: 0,
        distanceAfter: 0.037,
        instabilityBefore: 0.083,
        instabilityAfter: 0.12,
        fanCounts: { afferentCount: 22, efferentCount: 2, addedEdgeCount: 1 },
      });
    });

    it("recomputes with k = the genuinely-new edge count — two new edges give (Ce+2)/(Ca+Ce+2)", () => {
      const twoTargets = new Map(lowIFanFixture());
      twoTargets.set("src/other/c.ts", {
        name: "other",
        instability: 0.3,
        distanceFromMainSequence: 0.1,
        connectionCount: 24,
        afferentCount: 17,
        efferentCount: 7,
      });
      const result = runWith(
        { catalog: catalogOf(twoTargets) },
        ["src/api/barrel.ts"],
        [
          ["src/api/barrel.ts", "src/lib/b.ts"],
          ["src/api/barrel.ts", "src/other/c.ts"],
        ],
      );
      expect(subjectsOf(result, "mainSequence")).toEqual(["api"]);
      const finding = result.findings.find((f) => f.detector === "mainSequence");
      // I 2/24 -> 4/26 with A held at 22/24: D moves 0 -> 22/24 + 4/26 - 1 = 0.0705.
      expect(finding?.evidence).toMatchObject({
        distanceBefore: 0,
        distanceAfter: 0.071,
        instabilityBefore: 0.083,
        instabilityAfter: 0.154,
        fanCounts: { afferentCount: 22, efferentCount: 2, addedEdgeCount: 2 },
      });
    });

    it("keeps the small-N guard ahead of the recompute — a below-floor component is excluded and counted even when its fan counts are served", () => {
      const smallN = new Map<string, ComponentFact>([
        [
          "src/tiny/t.ts",
          {
            name: "tiny",
            instability: 1,
            distanceFromMainSequence: 0.2,
            connectionCount: 1,
            afferentCount: 0,
            efferentCount: 1,
          },
        ],
        [
          "src/lib/b.ts",
          {
            name: "lib",
            instability: 0.2,
            distanceFromMainSequence: 0.1,
            connectionCount: 8,
            afferentCount: 6,
            efferentCount: 2,
          },
        ],
      ]);
      const result = runWith({ catalog: catalogOf(smallN) }, ["src/tiny/t.ts"], [["src/tiny/t.ts", "src/lib/b.ts"]]);
      expect(subjectsOf(result, "mainSequence")).toEqual([]);
      expect(result.detectors.find((d) => d.detector === "mainSequence")).toMatchObject({
        excludedLowConnectionCount: 1,
      });
    });

    it("falls back to the +1-per-edge step when the catalog serves no fan counts — absence is never read as 'no edges' (documented fallback)", () => {
      const noFans = new Map<string, ComponentFact>([
        ["src/app/a.ts", { name: "app", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 9 }],
        ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 9 }],
      ]);
      const result = runWith({ catalog: catalogOf(noFans) }, ["src/app/a.ts"], [["src/app/a.ts", "src/lib/b.ts"]]);
      const finding = result.findings.find((f) => f.detector === "mainSequence");
      // The pre-89k7k.19 step, byte-identical: I 0.5 -> min(1, 1.5) = 1.0, A = 0.8, D 0.3 -> 0.8.
      expect(finding?.evidence).toEqual({
        distanceBefore: 0.3,
        distanceAfter: 0.8,
        instabilityBefore: 0.5,
        instabilityAfter: 1,
        edges: [{ sourceRelPath: "src/app/a.ts", targetRelPath: "src/lib/b.ts" }],
      });
    });
  });
});

// bd tea-rags-mcp-89k7k.14: stableDependencies and mainSequence judge the
// overlay's unique pairs MINUS the pairs the indexed graph already holds —
// only what the diff GENUINELY adds. A changed file's tree read re-serves
// every import it still holds, so judging the whole set read a one-line
// barrel edit as 23 new dependencies and saturated the barrel's component to
// I=1.000 (the recorded replay class).
describe("diff-added subtraction", () => {
  const components = new Map([
    ["src/app/a.ts", { name: "app", instability: 0.2, distanceFromMainSequence: 0.4 }],
    ["src/lib/b.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2 }],
    ["src/lib/c.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2 }],
  ]);

  it("does not judge a pair the indexed graph already holds — no SDP finding and no D-delta from a re-read import", () => {
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", "src/lib/b.ts"]]),
        catalog: catalogOf(components),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/b.ts"]],
    );
    expect(subjectsOf(result, "stableDependencies")).toEqual([]);
    expect(subjectsOf(result, "mainSequence")).toEqual([]);
  });

  it("still judges a genuinely new pair the indexed graph does not hold", () => {
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", "src/lib/c.ts"]]),
        catalog: catalogOf(components),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/b.ts"]],
    );
    expect(subjectsOf(result, "stableDependencies")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    expect(subjectsOf(result, "mainSequence")).toEqual(["app"]);
  });

  it("subtracts per pair, not per file — a changed file whose imports did not change contributes zero crossing edges", () => {
    // The barrel-edit replay class: every overlay pair is a pre-existing
    // import, so the D-delta machinery has nothing diff-added to weigh.
    const barrel = new Map<string, ComponentFact>([
      ["src/api/barrel.ts", { name: "api", instability: 0.054, distanceFromMainSequence: 0.0, connectionCount: 24 }],
      ["src/lib/b.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2, connectionCount: 24 }],
      ["src/lib/c.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2, connectionCount: 24 }],
    ]);
    const result = runWith(
      {
        graph: graphOf([
          ["src/api/barrel.ts", "src/lib/b.ts"],
          ["src/api/barrel.ts", "src/lib/c.ts"],
        ]),
        catalog: catalogOf(barrel),
      },
      ["src/api/barrel.ts"],
      [
        ["src/api/barrel.ts", "src/lib/b.ts"],
        ["src/api/barrel.ts", "src/lib/c.ts"],
      ],
    );
    expect(result.findings).toEqual([]);
  });

  it("judges every pair when the graph port is absent — nothing to subtract is never read as 'no edges added' (documented fallback)", () => {
    const run = new DiffDetectorRun({ catalog: catalogOf(components) });
    const result = run.run(
      { changedFiles: ["src/app/a.ts"] },
      overlayOf([["src/app/a.ts", "src/lib/b.ts"]], ["src/app/a.ts"]),
    );
    expect(subjectsOf(result, "stableDependencies")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    expect(subjectsOf(result, "mainSequence")).toEqual(["app"]);
  });

  it("keeps foundationTerminal on genuinely-new contracts edges — subtracting the pre-existing pairs never silences the annotation", () => {
    // The a3656904 replay class (bd tea-rags-mcp-r8hme.45): both findings
    // were single contracts edges the diff DID introduce; the file's other
    // pre-existing imports must not dilute or silence them.
    const toFoundation = new Map<string, ComponentFact>([
      ["src/app/a.ts", { name: "app", instability: 0.5, distanceFromMainSequence: 0.3, connectionCount: 9 }],
      ["src/lib/b.ts", { name: "lib", instability: 0.2, distanceFromMainSequence: 0.1, connectionCount: 9 }],
      [
        "src/core/contracts/types/x.ts",
        { name: "src/core/contracts/types", instability: 0.1, distanceFromMainSequence: 0.1, connectionCount: 9 },
      ],
    ]);
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", "src/lib/b.ts"]]),
        catalog: catalogOf(toFoundation, new Map(), CONTRACTS_FOUNDATION),
      },
      ["src/app/a.ts"],
      [
        ["src/app/a.ts", "src/lib/b.ts"],
        ["src/app/a.ts", "src/core/contracts/types/x.ts"],
      ],
    );
    const finding = result.findings.find((f) => f.detector === "mainSequence");
    expect(finding?.subject).toBe("app");
    expect(finding?.foundationTerminal).toBe(true);
  });
});

describe("pre-existing edge attribution", () => {
  // bd tea-rags-mcp-89k7k.1.13: cycles and leakingAbstraction judge the
  // overlay edge AS READ (89k7k.14), so a changed file re-serves edges the
  // index already holds — those findings must not be worded as diff-introduced.
  const FACADE = "src/lib/index.ts";
  const components = new Map([
    ["src/lib/internal.ts", { name: "lib", instability: 0.3, distanceFromMainSequence: 0.3 }],
  ]);
  const facades = new Map([["lib", FACADE]]);

  it("stamps preExisting on a cycle whose closing pair the indexed graph already holds, and says the edge pre-dates the diff", () => {
    const result = runWith(
      {
        graph: graphOf([
          ["src/a.ts", "src/b.ts"],
          ["src/b.ts", "src/c.ts"],
          ["src/c.ts", "src/a.ts"],
        ]),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/b.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "cycles");
    expect(finding?.subject).toBe("src/a.ts -> src/b.ts");
    expect(finding?.preExisting).toBe(true);
    expect(finding?.detail).toContain("pre-dates the diff");
    expect(finding?.detail).not.toContain("the new edge");
    expect(finding?.detail).not.toContain("the diff closes");
  });

  it("leaves a genuinely new cycle-closing pair unflagged, worded as the diff's new edge", () => {
    const result = runWith(
      {
        graph: graphOf([
          ["src/b.ts", "src/c.ts"],
          ["src/c.ts", "src/a.ts"],
        ]),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/b.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "cycles");
    expect(finding?.preExisting).toBeUndefined();
    expect("preExisting" in (finding ?? {})).toBe(false);
    expect(finding?.detail).toBe(
      "the diff closes a cycle: the new edge src/a.ts -> src/b.ts plus the indexed path back to src/a.ts",
    );
  });

  it("stamps preExisting on a leak whose pair the indexed graph already holds, and says the edge pre-dates the diff", () => {
    const result = runWith(
      {
        graph: graphOf([
          ["src/app/a.ts", FACADE],
          ["src/app/a.ts", "src/lib/internal.ts"],
        ]),
        catalog: catalogOf(components, facades),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/internal.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "leakingAbstraction");
    expect(finding?.subject).toBe("src/app/a.ts -> src/lib/internal.ts");
    expect(finding?.preExisting).toBe(true);
    expect(finding?.detail).toContain("pre-dates the diff");
    expect(finding?.detail).not.toContain("the diff reached past");
  });

  it("leaves a genuinely new leaking pair unflagged, worded as the diff's reach past the facade", () => {
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", FACADE]]),
        catalog: catalogOf(components, facades),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/internal.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "leakingAbstraction");
    expect("preExisting" in (finding ?? {})).toBe(false);
    expect(finding?.detail).toBe(
      `the diff reached past the facade src/app/a.ts already uses: src/lib/internal.ts is internal to lib, ` +
        `whose facade ${FACADE} src/app/a.ts imports`,
    );
  });

  it("marks nothing pre-existing when the graph port is absent — absence is an empty graph (documented fallback)", () => {
    const run = new DiffDetectorRun({ catalog: catalogOf(components, facades) });
    const result = run.run(
      { changedFiles: ["src/app/a.ts"] },
      overlayOf([["src/app/a.ts", "src/lib/internal.ts"]], ["src/app/a.ts"]),
    );
    expect(result.findings.some((f) => f.preExisting === true)).toBe(false);
  });
});

// bd tea-rags-mcp-89k7k.1.16: "added by the diff" is relative to the DIFF
// BASE (absent at the merge-base, present in the tree), never to wherever the
// index sits. The index can lag the base or already contain commits inside the
// diff range; both orderings must leave the verdict unchanged.
describe("diff-added relative to the diff base", () => {
  const components = new Map([
    ["src/app/a.ts", { name: "app", instability: 0.2, distanceFromMainSequence: 0.4 }],
    ["src/lib/b.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2 }],
  ]);
  const FACADE = "src/lib/index.ts";
  const leakComponents = new Map([
    ["src/lib/internal.ts", { name: "lib", instability: 0.3, distanceFromMainSequence: 0.3 }],
  ]);

  it("index between base and tree: an edge the diff added still counts as added although the index already holds it", () => {
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", "src/lib/b.ts"]]),
        catalog: catalogOf(components),
        baseEdges: baseEdgesOf({ "src/app/a.ts": [] }),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/b.ts"]],
    );
    expect(subjectsOf(result, "stableDependencies")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    expect(subjectsOf(result, "mainSequence")).toEqual(["app"]);
  });

  it("index between base and tree: a cycle the diff closed is not stamped preExisting", () => {
    const result = runWith(
      {
        graph: graphOf([
          ["src/a.ts", "src/b.ts"],
          ["src/b.ts", "src/c.ts"],
          ["src/c.ts", "src/a.ts"],
        ]),
        baseEdges: baseEdgesOf({ "src/a.ts": [] }),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/b.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "cycles");
    expect(finding?.subject).toBe("src/a.ts -> src/b.ts");
    expect("preExisting" in (finding ?? {})).toBe(false);
    expect(finding?.detail).toContain("the diff closes a cycle");
  });

  it("index older than base: an edge the base already held is not diff-added although the index lacks it", () => {
    const result = runWith(
      {
        graph: graphOf([]),
        catalog: catalogOf(components),
        baseEdges: baseEdgesOf({ "src/app/a.ts": ["src/lib/b.ts"] }),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/b.ts"]],
    );
    expect(subjectsOf(result, "stableDependencies")).toEqual([]);
    expect(subjectsOf(result, "mainSequence")).toEqual([]);
  });

  it("index older than base: a cycle edge the base already held is stamped preExisting, worded against the diff base", () => {
    const result = runWith(
      {
        graph: graphOf([
          ["src/b.ts", "src/c.ts"],
          ["src/c.ts", "src/a.ts"],
        ]),
        baseEdges: baseEdgesOf({ "src/a.ts": ["src/b.ts"] }),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/b.ts"]],
    );
    const finding = result.findings.find((f) => f.detector === "cycles");
    expect(finding?.preExisting).toBe(true);
    expect(finding?.detail).toContain("pre-dates the diff");
    expect(finding?.detail).toContain("diff base");
  });

  it("reads the facade evidence at the base too: a facade import the base held proves the pre-diff usage", () => {
    const result = runWith(
      {
        graph: graphOf([]),
        catalog: catalogOf(leakComponents, new Map([["lib", FACADE]])),
        baseEdges: baseEdgesOf({ "src/app/a.ts": [FACADE] }),
      },
      ["src/app/a.ts"],
      [
        ["src/app/a.ts", FACADE],
        ["src/app/a.ts", "src/lib/internal.ts"],
      ],
    );
    const finding = result.findings.find((f) => f.detector === "leakingAbstraction");
    expect(finding?.subject).toBe("src/app/a.ts -> src/lib/internal.ts");
    expect("preExisting" in (finding ?? {})).toBe(false);
  });

  it("falls back to the index for a source whose base edges are unknown", () => {
    const result = runWith(
      {
        graph: graphOf([["src/app/a.ts", "src/lib/b.ts"]]),
        catalog: catalogOf(components),
        baseEdges: baseEdgesOf({}),
      },
      ["src/app/a.ts"],
      [["src/app/a.ts", "src/lib/b.ts"]],
    );
    expect(subjectsOf(result, "stableDependencies")).toEqual([]);
  });
});

describe("silentCoupling", () => {
  // The run CONSUMES the production verdict (bd tea-rags-mcp-89k7k.1.10):
  // violations arrive already filtered by the detector's exclusion taxonomy,
  // strength cut and shared-neighbour explanation — the judge only intersects
  // them with the diff.
  const VIOLATION = { relPathA: "src/a.ts", relPathB: "src/p.ts", support: 9, strength: 0.57 };

  it("reports a production violation involving a changed file, with support and strength evidence", () => {
    const result = runWith({ silentCouplingFacts: factsOf([VIOLATION]) }, ["src/a.ts"], [["src/a.ts", "src/q.ts"]]);
    expect(subjectsOf(result, "silentCoupling")).toEqual(["src/a.ts ~ src/p.ts"]);
    expect(result.findings[0]?.endpoints).toEqual({
      kind: "filePair",
      sourceRelPath: "src/a.ts",
      targetRelPath: "src/p.ts",
    });
    expect(result.findings[0]?.evidence).toEqual({ support: 9, strength: 0.57 });
  });

  it("reports a violation whose changed file is the relPathB side", () => {
    const result = runWith({ silentCouplingFacts: factsOf([VIOLATION]) }, ["src/p.ts"], [["src/p.ts", "src/q.ts"]]);
    expect(subjectsOf(result, "silentCoupling")).toEqual(["src/p.ts ~ src/a.ts"]);
  });

  it("treats a pair the overlay adds a structural edge for as explained", () => {
    const result = runWith({ silentCouplingFacts: factsOf([VIOLATION]) }, ["src/a.ts"], [["src/a.ts", "src/p.ts"]]);
    expect(result.findings).toEqual([]);
  });

  it("skips pairs whose partner is also in the diff", () => {
    const result = runWith(
      { silentCouplingFacts: factsOf([VIOLATION]) },
      ["src/a.ts", "src/p.ts"],
      [["src/a.ts", "src/q.ts"]],
    );
    expect(result.findings).toEqual([]);
  });

  // bd tea-rags-mcp-89k7k.1.14 (presentation): live, 15 of 22 rows were one
  // locale file against each component — every pair real, the section
  // unreadable. Pairs sharing an endpoint list as ONE finding.
  it("groups pairs sharing an endpoint into one finding with every partner and a find_co_changed drill; others stay pairs", () => {
    const pair = (relPathB: string, support: number, strength: number, expectedSupport: number) => ({
      relPathA: "config/en.yml",
      relPathB,
      support,
      strength,
      expectedSupport,
    });
    const result = runWith(
      {
        silentCouplingFacts: factsOf([
          pair("src/p1.ts", 30, 0.71, 4.8),
          pair("src/p2.ts", 12, 0.62, 3.25),
          { relPathA: "src/b.ts", relPathB: "src/z.ts", support: 9, strength: 0.57 },
          pair("src/p3.ts", 20, 0.66, 4.1234),
        ]),
      },
      ["config/en.yml", "src/b.ts"],
      [["src/b.ts", "src/q.ts"]],
    );
    const silent = result.findings.filter((finding) => finding.detector === "silentCoupling");
    expect(silent).toEqual([
      {
        detector: "silentCoupling",
        subject: "config/en.yml co-changes significantly with 3 files without a structural edge",
        endpoints: { kind: "fileGroup", relPath: "config/en.yml", partnerCount: 3 },
        evidence: {
          topPartners: [
            { relPath: "src/p1.ts", support: 30, expectedSupport: 4.8, strength: 0.71 },
            { relPath: "src/p3.ts", support: 20, expectedSupport: 4.123, strength: 0.66 },
            { relPath: "src/p2.ts", support: 12, expectedSupport: 3.25, strength: 0.62 },
          ],
        },
        detail:
          "config/en.yml co-changes significantly with 3 files without a structural edge and the diff adds none; " +
          'drill in: call find_co_changed(files: ["config/en.yml"], limit: 3) to list this file\'s co-change partners',
        partners: [
          { relPath: "src/p1.ts", support: 30, expectedSupport: 4.8, strength: 0.71 },
          { relPath: "src/p3.ts", support: 20, expectedSupport: 4.123, strength: 0.66 },
          { relPath: "src/p2.ts", support: 12, expectedSupport: 3.25, strength: 0.62 },
        ],
        drillDown: {
          tool: "find_co_changed",
          files: ["config/en.yml"],
          limit: 3,
          hint: 'call find_co_changed(files: ["config/en.yml"], limit: 3) to list this file\'s co-change partners',
        },
      },
      expect.objectContaining({ subject: "src/b.ts ~ src/z.ts" }),
    ]);
    // Counts stay pair counts; the listed findings are counted beside them.
    const row = result.detectors.find((detector) => detector.detector === "silentCoupling");
    expect(row).toMatchObject({ findingCount: 4, groupedFindingCount: 2 });
  });

  // bd tea-rags-mcp-lxbrr: the cap limits which files are scanned as sources;
  // a partner the change touches past it is still in the change.
  it("skips a pair whose partner the change touches past the scan cap; an untouched partner still reports", () => {
    const run = new DiffDetectorRun({
      graph: graphOf([]),
      catalog: catalogOf(new Map()),
      silentCouplingFacts: factsOf([
        VIOLATION,
        { relPathA: "src/a.ts", relPathB: "src/r.ts", support: 8, strength: 0.56 },
      ]),
    });
    const result = run.run(
      { changedFiles: ["src/a.ts"], touchedFiles: new Set(["src/a.ts", "src/p.ts"]), skippedFiles: 1 },
      overlayOf([["src/a.ts", "src/q.ts"]], ["src/a.ts"]),
    );
    expect(subjectsOf(result, "silentCoupling")).toEqual(["src/a.ts ~ src/r.ts"]);
  });

  it("stays silent when a structural edge already exists in the reverse direction", () => {
    const result = runWith(
      {
        graph: graphOf([["src/p.ts", "src/a.ts"]]),
        silentCouplingFacts: factsOf([VIOLATION]),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/q.ts"]],
    );
    expect(result.findings).toEqual([]);
  });

  it("only judges the production violation list — a pair the snapshot's linkage union linked never reaches the judge", () => {
    // The type-only-import class (bd tea-rags-mcp-r8hme.12, tea-rags-mcp-89k7k.4):
    // the production detector links such pairs before they become violations, so
    // the facts the wiring hands over cannot contain them; a linked pair missing
    // from the list is silence here by construction.
    const result = runWith(
      { silentCouplingFacts: factsOf([{ relPathA: "src/a.ts", relPathB: "src/q.ts", support: 9, strength: 0.57 }]) },
      ["src/a.ts", "src/types.ts"],
      [],
    );
    expect(subjectsOf(result, "silentCoupling")).toEqual(["src/a.ts ~ src/q.ts"]);
  });

  it("reports each violation once when the scope lists its changed file twice", () => {
    const result = runWith(
      { silentCouplingFacts: factsOf([VIOLATION]) },
      ["src/a.ts", "src/a.ts"],
      [["src/a.ts", "src/q.ts"]],
    );
    expect(subjectsOf(result, "silentCoupling")).toEqual(["src/a.ts ~ src/p.ts"]);
  });

  it("carries the production excluded counters on the status row verbatim", () => {
    const result = runWith(
      {
        silentCouplingFacts: factsOf([VIOLATION], {
          testEndpoints: 112,
          documentationEndpoints: 24,
          unwalkedEndpoints: 4,
        }),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/q.ts"]],
    );
    const silentCoupling = result.detectors.find((detector) => detector.detector === "silentCoupling");
    expect(silentCoupling?.excluded).toEqual({
      testEndpoints: 112,
      generatedEndpoints: 0,
      documentationEndpoints: 24,
      unwalkedEndpoints: 4,
      notSignificant: 0,
      explainedByFacadeChain: 0,
    });
  });

  it("is silent without the facts port — absence is silence, no excluded block, never a zero verdict", () => {
    const result = runWith({}, ["src/a.ts"], [["src/a.ts", "src/q.ts"]]);
    expect(subjectsOf(result, "silentCoupling")).toEqual([]);
    const silentCoupling = result.detectors.find((detector) => detector.detector === "silentCoupling");
    expect(silentCoupling?.built).toBe(true);
    expect(silentCoupling?.findingCount).toBe(0);
    expect(silentCoupling?.excluded).toBeUndefined();
  });
});

describe("facadeContract", () => {
  const FACADE = "src/lib/index.ts";
  const facades = new Map([[FACADE, "src/lib"]]);

  it("reports the facade that stopped re-exporting a name an indexed consumer still imports", () => {
    const result = runWithContract(
      contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["a", "b"] }]]])),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]],
    );
    expect(subjectsOf(result, "facadeContract")).toEqual([FACADE]);
    const finding = result.findings.find((f) => f.detector === "facadeContract");
    expect(finding?.endpoints).toEqual({ kind: "file", relPath: FACADE, component: "src/lib" });
    expect(finding?.evidence).toEqual({ droppedNames: [{ name: "b", consumers: ["src/app/a.ts"] }] });
    expect(finding?.detail).toContain("stops re-exporting");
  });

  it("stays silent when every consumed name is still re-exported", () => {
    const result = runWithContract(
      contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["a", "b"] }]]])),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["a", "b"] }]],
    );
    expect(result.findings).toEqual([]);
  });

  it("skips a consumer the diff itself changes — its indexed row is stale, the diff judges its own read", () => {
    const result = runWithContract(
      contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["b"] }]]])),
      [FACADE, "src/app/a.ts"],
      [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]],
    );
    expect(result.findings).toEqual([]);
  });

  // bd tea-rags-mcp-lxbrr: "the diff changes it" is judged against the whole
  // change, not the cap's scanned subset — a past-cap consumer's indexed row is
  // just as stale.
  it("skips a consumer the change touches past the scan cap", () => {
    const run = new DiffDetectorRun({
      graph: graphOf([]),
      catalog: catalogOf(new Map()),
      contract: contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["b"] }]]])),
    });
    const result = run.run(
      { changedFiles: [FACADE], touchedFiles: new Set([FACADE, "src/app/a.ts"]), skippedFiles: 1 },
      namedOverlayOf([[FACADE, "src/lib/x.ts", { reexported: ["a"] }]], [FACADE]),
    );
    expect(result.findings).toEqual([]);
  });

  it("skips a consumer whose indexed row recorded no imported names", () => {
    const result = runWithContract(
      contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts" }]]])),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]],
    );
    expect(result.findings).toEqual([]);
  });

  it("skips a whole-module consumer — `*` pins no name", () => {
    const result = runWithContract(
      contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["*"] }]]])),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]],
    );
    expect(result.findings).toEqual([]);
  });

  it("skips a changed file no measured module claims as its facade", () => {
    const result = runWithContract(
      contractOf(new Map(), new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["b"] }]]])),
      ["src/lib/plain.ts"],
      [["src/lib/plain.ts", "src/lib/x.ts", { reexported: ["a"] }]],
    );
    expect(result.findings).toEqual([]);
  });

  it("skips a facade whose tree read recorded no re-export surface — not recorded is not exports-nothing", () => {
    const result = runWithContract(
      contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["b"] }]]])),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { imported: ["b"] }]],
    );
    expect(result.findings).toEqual([]);
  });

  it("never reports a consumed name the indexed surface did not record — a type-only re-export is unrecorded on both sides", () => {
    const result = runWithContract(
      contractOf(
        facades,
        new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["a", "b", "SomeType"] }]]]),
        new Map([[FACADE, ["a", "b"]]]),
      ),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]],
    );
    const finding = result.findings.find((f) => f.detector === "facadeContract");
    expect(finding?.evidence).toEqual({ droppedNames: [{ name: "b", consumers: ["src/app/a.ts"] }] });
  });

  it("skips a facade whose indexed read recorded no re-export surface — nothing recorded, nothing to drop from", () => {
    const result = runWithContract(
      contractOf(
        facades,
        new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["b"] }]]]),
        new Map([[FACADE, undefined]]),
      ),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]],
    );
    expect(result.findings).toEqual([]);
  });

  it("answers built:false with its reason without the contract port, built:true with it", () => {
    const absent = runWithContract(undefined, [FACADE], [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]]);
    expect(absent.detectors.find((entry) => entry.detector === "facadeContract")).toEqual({
      detector: "facadeContract",
      built: false,
      reason: "no contract reader",
      findingCount: 0,
    });

    const present = runWithContract(
      contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["b"] }]]])),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]],
    );
    expect(present.detectors.find((entry) => entry.detector === "facadeContract")).toEqual({
      detector: "facadeContract",
      built: true,
      findingCount: 1,
    });
  });

  it("aggregates one finding per facade: names sorted, sources sorted and distinct", () => {
    const result = runWithContract(
      contractOf(
        facades,
        new Map([
          [
            FACADE,
            [
              { source: "src/app/z.ts", importedNames: ["zz", "aa"] },
              { source: "src/app/a.ts", importedNames: ["aa", "mm"] },
            ],
          ],
        ]),
      ),
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["kept"] }]],
    );
    const finding = result.findings.find((f) => f.detector === "facadeContract");
    expect(finding?.evidence).toEqual({
      droppedNames: [
        { name: "aa", consumers: ["src/app/a.ts", "src/app/z.ts"] },
        { name: "mm", consumers: ["src/app/a.ts"] },
        { name: "zz", consumers: ["src/app/z.ts"] },
      ],
    });
  });

  it("judging the same overlay twice yields the identical findings and statuses", () => {
    const overlay = namedOverlayOf([[FACADE, "src/lib/x.ts", { reexported: ["a"] }]], [FACADE]);
    const run = new DiffDetectorRun({
      graph: graphOf([]),
      catalog: catalogOf(new Map()),
      contract: contractOf(facades, new Map([[FACADE, [{ source: "src/app/a.ts", importedNames: ["b"] }]]])),
    });
    const first = run.run({ changedFiles: [FACADE] }, overlay);
    const second = run.run({ changedFiles: [FACADE] }, overlay);
    expect(second.findings).toEqual(first.findings);
    expect(second.detectors).toEqual(first.detectors);
  });
});

describe("splitCandidates", () => {
  /** One component whose history splits into a y-group and an x-group (heaviest first). */
  const WIDE = new Map([
    ["src/wide/x1.ts", "wide"],
    ["src/wide/x2.ts", "wide"],
    ["src/wide/y1.ts", "wide"],
    ["src/wide/y2.ts", "wide"],
  ]);
  const splitVerdicts = {
    splitCandidates: [
      {
        component: "wide",
        clusters: 2,
        largestWeightShare: 0.52,
        files: [
          ["src/wide/y1.ts", "src/wide/y2.ts"],
          ["src/wide/x1.ts", "src/wide/x2.ts"],
        ],
      },
    ],
  } satisfies Partial<SplitMergeVerdicts>;

  it("fires when the diff touches two clusters of one component's split candidate", () => {
    const result = runWith({ splitMerge: splitMergeOf(splitVerdicts, WIDE) }, ["src/wide/x1.ts", "src/wide/y1.ts"], []);
    expect(result.findings.find((f) => f.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      subject: "wide",
      endpoints: { kind: "component", component: "wide" },
      evidence: {
        clusterCount: 2,
        touchedClusters: [
          { cluster: 1, fileCount: 2, changedFileCount: 1, changedFiles: ["src/wide/y1.ts"] },
          { cluster: 2, fileCount: 2, changedFileCount: 1, changedFiles: ["src/wide/x1.ts"] },
        ],
      },
      detail:
        "the diff works across the seam of wide, a component whose history already splits into 2 co-change groups",
    });
  });

  it("stays silent when the diff touches one cluster only", () => {
    const result = runWith({ splitMerge: splitMergeOf(splitVerdicts, WIDE) }, ["src/wide/x1.ts", "src/wide/x2.ts"], []);
    expect(subjectsOf(result, "splitCandidates")).toEqual([]);
  });

  it("caps each evidence line's file list at 4 while the counts stay honest", () => {
    const cluster = Array.from({ length: 6 }, (_, i) => `src/wide/c${i}.ts`);
    const wide = new Map([...cluster, "src/wide/other.ts"].map((relPath) => [relPath, "wide"]));
    const result = runWith(
      {
        splitMerge: splitMergeOf(
          {
            splitCandidates: [
              { component: "wide", clusters: 2, largestWeightShare: 0.5, files: [cluster, ["src/wide/other.ts"]] },
            ],
          },
          wide,
        ),
      },
      [...cluster, "src/wide/other.ts"],
      [],
    );
    const finding = result.findings.find((f) => f.detector === "splitCandidates");
    expect(finding?.evidence).toEqual({
      clusterCount: 2,
      touchedClusters: [
        { cluster: 1, fileCount: 6, changedFileCount: 6, changedFiles: cluster.slice(0, 4) },
        { cluster: 2, fileCount: 1, changedFileCount: 1, changedFiles: ["src/wide/other.ts"] },
      ],
    });
  });

  it("fires a merge finding when changed files sit on both sides of a candidate pair", () => {
    const sides = new Map([
      ["src/alpha/a1.ts", "alpha"],
      ["src/alpha/a2.ts", "alpha"],
      ["src/beta/b1.ts", "beta"],
    ]);
    const result = runWith(
      {
        splitMerge: splitMergeOf(
          {
            mergeCandidates: [
              { componentA: "alpha", componentB: "beta", support: 30, strength: 0.852, changesA: 32, changesB: 30 },
            ],
          },
          sides,
        ),
      },
      ["src/alpha/a1.ts", "src/alpha/a2.ts", "src/beta/b1.ts"],
      [],
    );
    expect(result.findings.find((f) => f.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      subject: "alpha ~ beta",
      endpoints: { kind: "componentPair", componentA: "alpha", componentB: "beta" },
      evidence: {
        strength: 0.852,
        sideA: { changedFileCount: 2, changedFiles: ["src/alpha/a1.ts", "src/alpha/a2.ts"] },
        sideB: { changedFileCount: 1, changedFiles: ["src/beta/b1.ts"] },
      },
      detail: "the diff bridges alpha and beta, two components whose admitted bundles already move them as one unit",
    });
  });

  it("is silent when a changed file maps to no component — undefined componentOf is silence", () => {
    const result = runWith(
      {
        splitMerge: splitMergeOf(
          {
            ...splitVerdicts,
            mergeCandidates: [
              { componentA: "alpha", componentB: "beta", support: 30, strength: 0.852, changesA: 32, changesB: 30 },
            ],
          },
          WIDE,
        ),
      },
      ["src/nowhere/n.ts"],
      [],
    );
    expect(result.findings.filter((f) => f.detector === "splitCandidates")).toEqual([]);
  });

  it("answers built:false with the passed reason without the port, built:true with it", () => {
    const absentWithReason = runWith({ splitMergeAbsentReason: "noBundleMembership" }, ["src/a.ts"], []);
    expect(absentWithReason.detectors.find((entry) => entry.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      built: false,
      reason: "noBundleMembership",
      findingCount: 0,
    });

    const absentBare = runWith({}, ["src/a.ts"], []);
    expect(absentBare.detectors.find((entry) => entry.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      built: false,
      reason: "noSplitMergeReader",
      findingCount: 0,
    });

    const present = runWith(
      { splitMerge: splitMergeOf(splitVerdicts, WIDE) },
      ["src/wide/x1.ts", "src/wide/y1.ts"],
      [],
    );
    expect(present.detectors.find((entry) => entry.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      built: true,
      findingCount: 1,
    });
  });

  it("judging the same overlay twice yields the identical findings and statuses", () => {
    const overlay = overlayOf([], ["src/wide/x1.ts", "src/wide/y1.ts"]);
    const run = new DiffDetectorRun({
      graph: graphOf([]),
      catalog: catalogOf(new Map()),
      splitMerge: splitMergeOf(splitVerdicts, WIDE),
    });
    const first = run.run({ changedFiles: ["src/wide/x1.ts", "src/wide/y1.ts"] }, overlay);
    const second = run.run({ changedFiles: ["src/wide/x1.ts", "src/wide/y1.ts"] }, overlay);
    expect(second.findings).toEqual(first.findings);
    expect(second.detectors).toEqual(first.detectors);
  });
});

describe("detectors", () => {
  it("lists the five built families with their counts, plus splitCandidates not built", () => {
    const result = runWith(
      {
        graph: graphOf([
          ["src/app/a.ts", "src/lib/index.ts"],
          ["src/b.ts", "src/c.ts"],
          ["src/c.ts", "src/a.ts"],
        ]),
        catalog: catalogOf(
          new Map([
            ["src/app/a.ts", { name: "app", instability: 0.2, distanceFromMainSequence: 0.4 }],
            ["src/lib/b.ts", { name: "lib", instability: 0.9, distanceFromMainSequence: 0.2 }],
          ]),
          new Map([["lib", "src/lib/index.ts"]]),
        ),
      },
      ["src/a.ts", "src/app/a.ts"],
      [
        ["src/a.ts", "src/b.ts"],
        ["src/app/a.ts", "src/lib/b.ts"],
      ],
    );

    expect(result.detectors.map((entry) => entry.detector)).toEqual([
      "stableDependencies",
      "leakingAbstraction",
      "cycles",
      "mainSequence",
      "silentCoupling",
      "facadeContract",
      "splitCandidates",
      "layeringBackEdge",
      "hubLike",
    ]);
    const unbuiltHere = new Set(["splitCandidates", "facadeContract", "layeringBackEdge", "hubLike"]);
    for (const entry of result.detectors) {
      if (unbuiltHere.has(entry.detector)) continue;
      expect(entry.built).toBe(true);
      expect(entry.reason).toBeUndefined();
      expect(entry.findingCount).toBe(result.findings.filter((finding) => finding.detector === entry.detector).length);
    }
    expect(result.detectors.find((entry) => entry.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      built: false,
      reason: "noSplitMergeReader",
      findingCount: 0,
    });
    // No contract port injected here, so the facade-contract family is the
    // second honestly-unbuilt row.
    expect(result.detectors.find((entry) => entry.detector === "facadeContract")).toEqual({
      detector: "facadeContract",
      built: false,
      reason: "no contract reader",
      findingCount: 0,
    });
    // No layering reading injected either — the third honestly-unbuilt row.
    expect(result.detectors.find((entry) => entry.detector === "layeringBackEdge")).toEqual({
      detector: "layeringBackEdge",
      built: false,
      reason: "no layering reading",
      findingCount: 0,
    });
    // Nor a hub-like reading — the fourth.
    expect(result.detectors.find((entry) => entry.detector === "hubLike")).toEqual({
      detector: "hubLike",
      built: false,
      reason: "no hub-like reading",
      findingCount: 0,
    });
  });
});

describe("absence of data", () => {
  it("is never a violation: every fact absent over real edges stays silent", () => {
    const result = runWith({}, ["src/a.ts"], [["src/a.ts", "src/b.ts"]]);
    expect(result.findings).toEqual([]);
    for (const entry of result.detectors) {
      expect(entry.findingCount).toBe(0);
    }
  });

  it("returns an empty report for an empty scope", () => {
    const result = runWith({}, [], []);
    expect(result.findings).toEqual([]);
    expect(result.detectors.filter((entry) => entry.built)).toHaveLength(5);
  });
});

// bd tea-rags-mcp-89k7k.1.9: a truncated diff scope — changed files fell past
// the reader's file cap — must never read as a clean pass. The closing edge of
// a cycle can live ONLY in a skipped file, so a zero over unseen files is
// partial, and the status says so with the skipped count.
describe("detector statuses over a truncated diff scope", () => {
  function runScope(scope: { changedFiles: readonly string[]; skippedFiles?: number }): DiffDetectorFindings {
    return new DiffDetectorRun({
      graph: graphOf([]),
      catalog: catalogOf(new Map()),
    }).run(scope, overlayOf([], scope.changedFiles));
  }

  it("marks every BUILT family partial with the skipped count — a zero over unseen files is never a clean pass", () => {
    const result = runScope({ changedFiles: ["src/a.ts"], skippedFiles: 3 });
    for (const status of result.detectors) {
      if (!status.built) continue;
      expect(status, `${status.detector} claimed a clean pass over a truncated diff`).toMatchObject({
        scopeSkippedFiles: 3,
      });
    }
  });

  it("an unbuilt family keeps its built:false reason — absence was never a clean pass either, and carries no marker", () => {
    const result = runScope({ changedFiles: ["src/a.ts"], skippedFiles: 3 });
    const unbuilt = result.detectors.filter((status) => !status.built);
    expect(unbuilt.length).toBeGreaterThan(0);
    for (const status of unbuilt) {
      expect(status.scopeSkippedFiles).toBeUndefined();
      expect(status.reason).toBeDefined();
    }
  });

  it("an untruncated scope carries no marker — zeros are then clean passes", () => {
    const result = runScope({ changedFiles: ["src/a.ts"] });
    expect(result.detectors.every((status) => status.scopeSkippedFiles === undefined)).toBe(true);
    expect(result.detectors.every((status) => status.scopeSkippedFiles !== 0)).toBe(true);
  });
});
