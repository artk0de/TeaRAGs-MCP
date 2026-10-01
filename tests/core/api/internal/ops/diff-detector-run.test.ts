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
  type DiffDetectorCouplingReader,
  type DiffDetectorFinding,
  type DiffDetectorFindings,
  type DiffDetectorGraphReader,
} from "../../../../../src/core/api/internal/ops/diff-detector-run.js";
import { ReviewEdgeOverlay } from "../../../../../src/core/api/internal/ops/review-edge-overlay.js";

/** A file edge as a fixture tuple. */
type FixtureEdge = readonly [source: string, target: string];

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
    maxTraceHops?: number;
  },
  changedFiles: readonly string[],
  overlayEdges: readonly FixtureEdge[],
): DiffDetectorFindings {
  const run = new DiffDetectorRun({
    graph: deps.graph ?? graphOf([]),
    catalog: deps.catalog ?? catalogOf(new Map()),
    coupling: deps.coupling ?? couplingOf(new Map()),
    ...(deps.maxTraceHops !== undefined ? { maxTraceHops: deps.maxTraceHops } : {}),
  });
  return run.run({ changedFiles }, overlayOf(overlayEdges, changedFiles));
}

/** Subjects of one detector's findings, in emission order. */
function subjectsOf(result: DiffDetectorFindings, detector: DiffDetectorFinding["detector"]): string[] {
  return result.findings.filter((finding) => finding.detector === detector).map((finding) => finding.subject);
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
      "splitCandidates",
    ]);
    for (const entry of result.detectors) {
      if (entry.detector === "splitCandidates") continue;
      expect(entry.built).toBe(true);
      expect(entry.reason).toBeUndefined();
      expect(entry.findingCount).toBe(result.findings.filter((finding) => finding.detector === entry.detector).length);
    }
    expect(result.detectors.find((entry) => entry.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      built: false,
      reason: "A5/c3v6o substrate not built",
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
