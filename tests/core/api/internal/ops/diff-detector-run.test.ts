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
  type DiffDetectorCatalog,
  type DiffDetectorContractReader,
  type DiffDetectorCouplingReader,
  type DiffDetectorFinding,
  type DiffDetectorFindings,
  type DiffDetectorGraphReader,
  type DiffDetectorSplitMergeReader,
} from "../../../../../src/core/api/internal/ops/diff-detector-run.js";
import { ReviewEdgeOverlay } from "../../../../../src/core/api/internal/ops/review-edge-overlay.js";
import type { SplitMergeVerdicts } from "../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

/** A file edge as a fixture tuple. */
type FixtureEdge = readonly [source: string, target: string];

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

/** The report's markedly-less-stable band, stubbed at a 0.3 tolerance. */
const MARKEDLY_LESS_STABLE_TOLERANCE = 0.3;

/** Indexed-graph reader over plain edge tuples: forward and reverse indices. */
function graphOf(edges: readonly FixtureEdge[]): DiffDetectorGraphReader {
  const outgoing = new Map<string, { source: string; target: string }[]>();
  const incoming = new Map<string, { source: string; target: string }[]>();
  for (const [source, target] of edges) {
    pushTo(outgoing, source, { source, target });
    pushTo(incoming, target, { source, target });
  }
  return {
    edgesFrom: (relPath) => outgoing.get(relPath) ?? [],
    edgesTo: (relPath) => incoming.get(relPath) ?? [],
  };
}

/** Report-derived component/facade facts keyed the way the catalog serves them. */
function catalogOf(
  components: ReadonlyMap<string, { name: string; instability: number; distanceFromMainSequence: number }>,
  facades: ReadonlyMap<string, string> = new Map(),
): DiffDetectorCatalog {
  return {
    componentOf: (relPath) => components.get(relPath),
    facadeOf: (componentName) => facades.get(componentName),
    isMarkedlyLessStable: (leanOn, leanedOn) => leanOn - leanedOn >= MARKEDLY_LESS_STABLE_TOLERANCE,
  };
}

/** Co-change pairs per changed file, from plain tuples. */
function couplingOf(
  pairs: ReadonlyMap<string, readonly { partner: string; support: number }[]>,
): DiffDetectorCouplingReader {
  return { partnersOf: (relPath) => pairs.get(relPath) ?? [] };
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

/** The review's overlay: one read per changed file, its edges picked from the tuples. */
function overlayOf(edges: readonly FixtureEdge[], changed: readonly string[]): ReviewEdgeOverlay {
  return new ReviewEdgeOverlay(
    changed.map((relPath) => ({
      relPath,
      edges: edges
        .filter(([source]) => source === relPath)
        .map(([sourceRelPath, targetRelPath]) => ({ sourceRelPath, targetRelPath })),
    })),
  );
}

function runWith(
  deps: {
    graph?: DiffDetectorGraphReader;
    catalog?: DiffDetectorCatalog;
    coupling?: DiffDetectorCouplingReader;
    splitMerge?: DiffDetectorSplitMergeReader;
    splitMergeAbsentReason?: string;
    maxTraceHops?: number;
  },
  changedFiles: readonly string[],
  overlayEdges: readonly FixtureEdge[],
): DiffDetectorFindings {
  const run = new DiffDetectorRun({
    graph: deps.graph ?? graphOf([]),
    catalog: deps.catalog ?? catalogOf(new Map()),
    coupling: deps.coupling ?? couplingOf(new Map()),
    ...(deps.splitMerge !== undefined ? { splitMerge: deps.splitMerge } : {}),
    ...(deps.splitMergeAbsentReason !== undefined ? { splitMergeAbsentReason: deps.splitMergeAbsentReason } : {}),
    ...(deps.maxTraceHops !== undefined ? { maxTraceHops: deps.maxTraceHops } : {}),
  });
  return run.run({ changedFiles }, overlayOf(overlayEdges, changedFiles));
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
    coupling: couplingOf(new Map()),
    ...(contract !== undefined ? { contract } : {}),
  });
  return run.run({ changedFiles }, namedOverlayOf(overlayEdges, changedFiles));
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
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
    expect(finding?.evidence.length).toBeGreaterThan(0);
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
    expect(result.findings[0]?.evidence).toContain(`pre-existing src/app/a.ts -> ${FACADE}`);
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
    expect(result.findings[0]?.evidence).toContain("src/a.ts -> src/b.ts -> src/c.ts -> src/a.ts");
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
    expect(unmasked.findings[0]?.evidence).toContain("src/a.ts -> src/b.ts -> src/m.ts -> src/a.ts");
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
    expect(finding?.evidence[0]).toBe("D 0.300 -> 0.800");
    expect(finding?.evidence).toContain("src/app/a.ts -> src/lib/b.ts");
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
});

describe("silentCoupling", () => {
  const COUPLING = new Map([["src/a.ts", [{ partner: "src/p.ts", support: 0.82 }]]]);

  it("reports an unexplained strong pair", () => {
    const result = runWith({ coupling: couplingOf(COUPLING) }, ["src/a.ts"], [["src/a.ts", "src/q.ts"]]);
    expect(subjectsOf(result, "silentCoupling")).toEqual(["src/a.ts ~ src/p.ts"]);
    expect(result.findings[0]?.evidence[0]).toContain("0.820");
  });

  it("treats a pair the overlay adds a structural edge for as explained", () => {
    const result = runWith({ coupling: couplingOf(COUPLING) }, ["src/a.ts"], [["src/a.ts", "src/p.ts"]]);
    expect(result.findings).toEqual([]);
  });

  it("skips pairs whose partner is also in the diff", () => {
    const result = runWith({ coupling: couplingOf(COUPLING) }, ["src/a.ts", "src/p.ts"], [["src/a.ts", "src/q.ts"]]);
    expect(result.findings).toEqual([]);
  });

  it("stays silent when a structural edge already exists in the reverse direction", () => {
    const result = runWith(
      {
        graph: graphOf([["src/p.ts", "src/a.ts"]]),
        coupling: couplingOf(COUPLING),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/q.ts"]],
    );
    expect(result.findings).toEqual([]);
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
    expect(finding?.evidence).toEqual(["b: consumed by src/app/a.ts"]);
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
    expect(finding?.evidence).toEqual(["b: consumed by src/app/a.ts"]);
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
    expect(finding?.evidence).toEqual([
      "aa: consumed by src/app/a.ts, src/app/z.ts",
      "mm: consumed by src/app/a.ts",
      "zz: consumed by src/app/z.ts",
    ]);
  });

  it("judging the same overlay twice yields the identical findings and statuses", () => {
    const overlay = namedOverlayOf([[FACADE, "src/lib/x.ts", { reexported: ["a"] }]], [FACADE]);
    const run = new DiffDetectorRun({
      graph: graphOf([]),
      catalog: catalogOf(new Map()),
      coupling: couplingOf(new Map()),
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
      evidence: [
        "cluster 1: 1 of 2 changed files — src/wide/y1.ts",
        "cluster 2: 1 of 2 changed files — src/wide/x1.ts",
      ],
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
    expect(finding?.evidence).toEqual([
      `cluster 1: 6 of 6 changed files — ${cluster.slice(0, 4).join(", ")}`,
      "cluster 2: 1 of 1 changed files — src/wide/other.ts",
    ]);
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
      evidence: ["strength 0.852", "alpha: src/alpha/a1.ts, src/alpha/a2.ts", "beta: src/beta/b1.ts"],
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
      coupling: couplingOf(new Map()),
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
        coupling: couplingOf(new Map([["src/a.ts", [{ partner: "src/p.ts", support: 0.9 }]]])),
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
    ]);
    for (const entry of result.detectors) {
      if (entry.detector === "splitCandidates" || entry.detector === "facadeContract") continue;
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
  });
});

describe("absence of data", () => {
  it("is never a violation: every fact absent over real edges stays silent", () => {
    const result = runWith(
      { coupling: couplingOf(new Map([["src/a.ts", []]])) },
      ["src/a.ts"],
      [["src/a.ts", "src/b.ts"]],
    );
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
      coupling: couplingOf(new Map()),
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
