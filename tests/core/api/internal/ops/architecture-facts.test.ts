/**
 * `architecture-facts` (bd tea-rags-mcp-89k7k.1.4, F3 slice 2): the derived
 * facts extracted out of `architecture-report-ops` so the diff-scoped detector
 * run consumes the SAME derivations the whole-repo report judges through —
 * the production graph read, the component partition over the
 * leaking-abstraction facade classification, the main-sequence distance map,
 * and the instability band predicate. The report's own untouched suite
 * (`architecture-report-ops.test.ts`) is the regression gate for the moved
 * primitives; what is pinned HERE is the extracted surface itself: the shapes
 * the `DiffDetectorCatalog` port consumes and the band's boundary.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ArchitectureFactsCatalog,
  deriveArchitectureComponentFacts,
  distanceFromMainSequenceByComponent,
  isMarkedlyLessStableBySdpBand,
  readProductionArchitectureGraph,
} from "../../../../../src/core/api/internal/ops/architecture-facts.js";
import type {
  FileDependencyEdge,
  FileDependencyGraph,
  FileDependencyGraphFile,
  RelPath,
} from "../../../../../src/core/contracts/types/codegraph.js";
import { DEFAULT_SDP_TOLERANCE } from "../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

function file(relPath: RelPath, typeAbstractness?: { abstractTypeCount: number; concreteTypeCount: number }) {
  return { relPath, language: "typescript", symbolCount: 1, ...(typeAbstractness ? { typeAbstractness } : {}) };
}

function edge(sourceRelPath: RelPath, targetRelPath: RelPath): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

function graphOf(files: FileDependencyGraphFile[], edges: FileDependencyEdge[]): FileDependencyGraph {
  return { files, edges };
}

describe("readProductionArchitectureGraph", () => {
  it("reads the indexed graph once and excludes non-production paths from it, carrying the filter", async () => {
    const graphDb = {
      readFileDependencyGraph: vi.fn(async () =>
        graphOf(
          [file("src/a.ts"), file("scripts/spike.ts"), file("spikes/try.ts")],
          [edge("src/a.ts", "spikes/try.ts"), edge("scripts/spike.ts", "src/a.ts")],
        ),
      ),
    };

    const production = await readProductionArchitectureGraph(graphDb);

    expect(graphDb.readFileDependencyGraph).toHaveBeenCalledTimes(1);
    expect(production.excludedFileCount).toBe(2);
    expect(production.excludedEdgeCount).toBe(2);
    expect(production.graph.files.map((f) => f.relPath)).toEqual(["src/a.ts"]);
    expect(production.graph.edges).toEqual([]);
    // The filter rides along: the report re-uses it for the member-edge privacy pass.
    expect(production.nonProduction.ignores("scripts/spike.ts")).toBe(true);
    expect(production.nonProduction.ignores("src/a.ts")).toBe(false);
  });
});

describe("deriveArchitectureComponentFacts", () => {
  it("partitions the graph into directory components and classifies facade modules — the same derivation the report judges through", () => {
    const graph = graphOf(
      [file("src/app/a.ts"), file("src/lib/b.ts"), file("src/lib/c.ts")],
      [edge("src/lib/b.ts", "src/app/a.ts"), edge("src/app/a.ts", "src/lib/c.ts")],
    );

    const facts = deriveArchitectureComponentFacts(graph);

    expect(facts.components.componentOf.get("src/app/a.ts")).toBe("src/app");
    expect(facts.components.componentOf.get("src/lib/b.ts")).toBe("src/lib");
    const app = facts.components.components.get("src/app");
    const lib = facts.components.components.get("src/lib");
    expect(app?.kind).toBe("directory");
    expect(app?.instability).toBeCloseTo(0.5, 10); // Ce 1 / (Ca 1 + Ce 1)
    expect(lib?.instability).toBeCloseTo(0.5, 10);
    // No entry file anywhere: every candidate module is absent, the partition is directories only.
    expect(facts.leaks.modules).toEqual([]);
  });
});

describe("distanceFromMainSequenceByComponent", () => {
  /**
   * A rigid component (five importers, six concrete types, nothing abstract,
   * no outgoing edge): A=0, I=0, D=1 — the zone of pain, past the report's
   * distance floor. Its importer component sits closer to the sequence
   * (D=1/3, below the floor) and is therefore never REPORTED, so it carries
   * no D — the documented absence the catalog reads as "on the sequence".
   */
  function painFixture(): FileDependencyGraph {
    const flexible = [1, 2, 3, 4, 5].map((n) => file(`flex/f${n}.ts`, { abstractTypeCount: 2, concreteTypeCount: 4 }));
    return graphOf(
      [file("rigid/x.ts", { abstractTypeCount: 0, concreteTypeCount: 6 }), ...flexible],
      [...[1, 2, 3, 4, 5].map((n) => edge(`flex/f${n}.ts`, "rigid/x.ts"))],
    );
  }

  it("carries D for exactly the components the report's detector reports, verbatim", () => {
    const graph = painFixture();
    const facts = deriveArchitectureComponentFacts(graph);
    const distances = distanceFromMainSequenceByComponent(facts.components, graph.files);

    expect(distances.get("rigid")).toBeCloseTo(1, 10);
    expect(distances.has("flex")).toBe(false);
  });
});

describe("ArchitectureFactsCatalog", () => {
  function catalogFixture() {
    const graph = graphOf(
      [file("src/app/a.ts"), file("src/lib/b.ts"), file("src/other/c.ts")],
      [edge("src/lib/b.ts", "src/app/a.ts")],
    );
    const facts = deriveArchitectureComponentFacts(graph);
    const distances = distanceFromMainSequenceByComponent(facts.components, graph.files);
    return new ArchitectureFactsCatalog(facts, distances);
  }

  it("serves componentOf with the partition's name and instability; a file outside the graph is undefined", () => {
    const catalog = catalogFixture();
    const app = catalog.componentOf("src/app/a.ts");
    const lib = catalog.componentOf("src/lib/b.ts");
    expect(app?.name).toBe("src/app");
    expect(lib?.name).toBe("src/lib");
    // lib Ce 1 / (Ca 0 + Ce 1); app Ca 1 / (Ca 1 + Ce 0).
    expect(lib?.instability).toBeCloseTo(1, 10);
    expect(app?.instability).toBeCloseTo(0, 10);
    expect(catalog.componentOf("src/unwalked.ts")).toBeUndefined();
  });

  it("reads distanceFromMainSequence off the report's map, an absent D as 0 — on the sequence", () => {
    const catalog = catalogFixture();
    // Neither component is reported off the sequence in this fixture: the
    // documented fallback reads them as starting ON it, so a diff's delta is
    // the distance the diff itself creates.
    expect(catalog.componentOf("src/app/a.ts")?.distanceFromMainSequence).toBe(0);
    const pain = (() => {
      const flexible = [1, 2, 3, 4, 5].map((n) =>
        file(`flex/f${n}.ts`, { abstractTypeCount: 2, concreteTypeCount: 4 }),
      );
      const graph = graphOf(
        [file("rigid/x.ts", { abstractTypeCount: 0, concreteTypeCount: 6 }), ...flexible],
        [...[1, 2, 3, 4, 5].map((n) => edge(`flex/f${n}.ts`, "rigid/x.ts"))],
      );
      const facts = deriveArchitectureComponentFacts(graph);
      return new ArchitectureFactsCatalog(facts, distanceFromMainSequenceByComponent(facts.components, graph.files));
    })();
    expect(pain.componentOf("rigid/x.ts")?.distanceFromMainSequence).toBeCloseTo(1, 10);
  });

  it("facadeOf is undefined for a directory component — only a measured module facade answers", () => {
    const catalog = catalogFixture();
    expect(catalog.facadeOf("src/app")).toBeUndefined();
    expect(catalog.facadeOf("no/such")).toBeUndefined();
  });

  it("isMarkedlyLessStable answers the report's own SDP band", () => {
    const catalog = catalogFixture();
    // Exactly at the tolerance is NOT markedly less stable (the detector flags
    // `delta > tolerance`); beyond it is.
    expect(catalog.isMarkedlyLessStable(0.3 + DEFAULT_SDP_TOLERANCE, 0.3)).toBe(false);
    expect(catalog.isMarkedlyLessStable(0.3 + DEFAULT_SDP_TOLERANCE + 0.05, 0.3)).toBe(true);
    expect(catalog.isMarkedlyLessStable(0.2, 0.9)).toBe(false);
  });
});

describe("isMarkedlyLessStableBySdpBand", () => {
  it("breaks strictly beyond the report's tolerance, both directions of the same band", () => {
    expect(isMarkedlyLessStableBySdpBand(0.9, 0.2)).toBe(true);
    expect(isMarkedlyLessStableBySdpBand(0.2, 0.9)).toBe(false);
    expect(isMarkedlyLessStableBySdpBand(0.5, 0.5)).toBe(false);
    expect(isMarkedlyLessStableBySdpBand(DEFAULT_SDP_TOLERANCE + 1e-6, 0)).toBe(true);
    expect(isMarkedlyLessStableBySdpBand(DEFAULT_SDP_TOLERANCE, 0)).toBe(false);
  });
});
