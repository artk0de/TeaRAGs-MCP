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
  measureLayeringFoundationAndTerminalComponents,
  measureLayeringFoundationFiles,
  measureMainSequenceDistances,
  readProductionArchitectureGraph,
} from "../../../../../src/core/api/internal/ops/architecture-facts.js";
import type {
  FileDependencyEdge,
  FileDependencyGraph,
  FileDependencyGraphFile,
  RelPath,
} from "../../../../../src/core/contracts/types/codegraph.js";
import {
  DEFAULT_SDP_TOLERANCE,
  detectMainSequenceDeviations,
} from "../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

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

  it("excludes test support — files only tests and other support import — and counts it apart (bd tea-rags-mcp-89k7k.35.3)", async () => {
    const graphDb = {
      readFileDependencyGraph: vi.fn(async () =>
        graphOf(
          [
            file("src/modal/Modal.tsx"),
            file("src/modal/public.ts"),
            file("src/modal/specs/Modal.spec.presets.tsx"),
            file("src/modal/specs/builder.ts"),
            file("src/used-by-script.ts"),
            file("scripts/spike.ts"),
          ],
          [
            edge("src/modal/public.ts", "src/modal/Modal.tsx"),
            edge("src/modal/specs/Modal.spec.presets.tsx", "src/modal/Modal.tsx"),
            edge("src/modal/specs/Modal.spec.presets.tsx", "src/modal/specs/builder.ts"),
            edge("scripts/spike.ts", "src/used-by-script.ts"),
          ],
        ),
      ),
    };
    const readIndexedFileImports = vi.fn(async () => {
      return new Map([
        [
          "src/modal/specs/Modal.spec.tsx",
          { isTest: true, specifiers: ["./Modal.spec.presets", "src/modal/Modal", "msw/node", "@faker-js/faker"] },
        ],
        ["tests/used-by-script.test.ts", { isTest: true, specifiers: ["../src/used-by-script.js", "msw"] }],
        // Positive evidence (89k7k.35.3): each support file imports a package
        // tests import and no production file does.
        ["src/modal/specs/Modal.spec.presets.tsx", { isTest: false, specifiers: ["../Modal", "./builder", "msw"] }],
        ["src/modal/specs/builder.ts", { isTest: false, specifiers: ["@faker-js/faker"] }],
        ["src/used-by-script.ts", { isTest: false, specifiers: ["node:fs"] }],
      ]);
    });

    const production = await readProductionArchitectureGraph(graphDb, readIndexedFileImports);

    expect(readIndexedFileImports).toHaveBeenCalledTimes(1);
    expect(production.excludedFileCount).toBe(1);
    expect(production.testSupport).toEqual({ excludedFileCount: 2, excludedEdgeCount: 2, testOnlyDependencyCount: 2 });
    expect(production.graph.files.map((f) => f.relPath)).toEqual([
      "src/modal/Modal.tsx",
      "src/modal/public.ts",
      "src/used-by-script.ts",
    ]);
    expect(production.graph.edges).toEqual([edge("src/modal/public.ts", "src/modal/Modal.tsx")]);
    // The privacy pass reads the same exclusion through the carried filter.
    expect(production.nonProduction.ignores("src/modal/specs/builder.ts")).toBe(true);
    expect(production.nonProduction.ignores("src/modal/Modal.tsx")).toBe(false);
  });

  it("counts a package the manifests declare for development only as test-only evidence, though production imports it (bd tea-rags-mcp-89k7k.35.3)", async () => {
    const graphDb = {
      readFileDependencyGraph: vi.fn(async () =>
        graphOf(
          [file("src/modal/Modal.tsx"), file("src/modal/public.ts"), file("src/modal/specs/renderHelper.tsx")],
          [edge("src/modal/public.ts", "src/modal/Modal.tsx")],
        ),
      ),
    };
    const readIndexedFileImports = async () =>
      new Map([
        ["src/modal/specs/Modal.test.tsx", { isTest: true, specifiers: ["./renderHelper", "@testing-library/react"] }],
        ["src/modal/specs/renderHelper.tsx", { isTest: false, specifiers: ["@testing-library/react"] }],
        ["src/modal/Modal.tsx", { isTest: false, specifiers: ["@testing-library/react"] }],
      ]);
    const readDeclaredTestDependencies = vi.fn(() => new Set(["@testing-library/react"]));

    const production = await readProductionArchitectureGraph(
      graphDb,
      readIndexedFileImports,
      readDeclaredTestDependencies,
    );

    expect(readDeclaredTestDependencies).toHaveBeenCalledTimes(1);
    expect(production.testSupport).toEqual({ excludedFileCount: 1, excludedEdgeCount: 0, testOnlyDependencyCount: 1 });
    expect(production.nonProduction.ignores("src/modal/specs/renderHelper.tsx")).toBe(true);
  });

  it("excludes no test support when no test-import read is wired", async () => {
    const graphDb = {
      readFileDependencyGraph: vi.fn(async () =>
        graphOf([file("src/a.ts"), file("src/a.presets.ts")], [edge("src/a.presets.ts", "src/a.ts")]),
      ),
    };

    const production = await readProductionArchitectureGraph(graphDb);

    expect(production.testSupport).toEqual({ excludedFileCount: 0, excludedEdgeCount: 0, testOnlyDependencyCount: 0 });
    expect(production.graph.files).toHaveLength(2);
  });
});

describe("readProductionArchitectureGraph — concurrent reads (bd tea-rags-mcp-pqdw4)", () => {
  /** A promise the test settles by hand, to observe what starts while a read is in flight. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("starts the graph and the import read together and reads the manifests while both are in flight", async () => {
    const graph = deferred<FileDependencyGraph>();
    const imports = deferred<Map<RelPath, { isTest: boolean; specifiers: string[] }>>();
    const order: string[] = [];
    const graphDb = {
      readFileDependencyGraph: vi.fn(async () => {
        order.push("graph");
        return graph.promise;
      }),
    };
    const readIndexedFileImports = vi.fn(async () => {
      order.push("imports");
      return imports.promise;
    });
    const readDeclaredTestDependencies = vi.fn(() => {
      order.push("manifests");
      return new Set<string>();
    });

    const pending = readProductionArchitectureGraph(graphDb, readIndexedFileImports, readDeclaredTestDependencies);
    await Promise.resolve();

    expect(order).toEqual(["graph", "imports", "manifests"]);
    graph.resolve(graphOf([file("src/a.ts")], []));
    imports.resolve(new Map());
    expect((await pending).graph.files.map((f) => f.relPath)).toEqual(["src/a.ts"]);
  });

  it("rejects with the graph read's failure, leaving no unhandled rejection behind", async () => {
    const graphDb = { readFileDependencyGraph: vi.fn(async () => Promise.reject(new Error("graph down"))) };
    const readIndexedFileImports = vi.fn(async () => Promise.reject(new Error("qdrant down")));

    await expect(readProductionArchitectureGraph(graphDb, readIndexedFileImports)).rejects.toThrow("graph down");
  });

  it("rejects with the manifest read's failure while the reads are in flight, leaving no unhandled rejection", async () => {
    const graphDb = { readFileDependencyGraph: vi.fn(async () => Promise.reject(new Error("graph down"))) };
    const readIndexedFileImports = vi.fn(async () => Promise.reject(new Error("qdrant down")));
    const readDeclaredTestDependencies = vi.fn((): ReadonlySet<string> => {
      throw new Error("manifest unreadable");
    });

    await expect(
      readProductionArchitectureGraph(graphDb, readIndexedFileImports, readDeclaredTestDependencies),
    ).rejects.toThrow("manifest unreadable");
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

  // bd tea-rags-mcp-89k7k.1.19.2: the diff run's mainSequence `preExisting`
  // compares D before the diff against the report's own threshold — served
  // from the SAME detector call that produced the distances.
  it("measureMainSequenceDistances serves the same distances plus the report's distance threshold", () => {
    const graph = painFixture();
    const facts = deriveArchitectureComponentFacts(graph);
    const measured = measureMainSequenceDistances(facts.components, graph.files);

    expect(measured.distanceByComponent).toEqual(distanceFromMainSequenceByComponent(facts.components, graph.files));
    expect(measured.distanceThreshold).toBe(
      detectMainSequenceDeviations(facts.components, graph.files).summary.distanceThreshold,
    );
  });
});

// bd tea-rags-mcp-hv38q: the diff run's leakingAbstraction asks the report's
// own facade-leak rule — the predicate is derived with the facts, from the
// SAME leaks report, never a second copy of the rule.
describe("ArchitectureFactsCatalog#facadeLeakOf", () => {
  function adoptedModuleGraph(): FileDependencyGraph {
    return graphOf(
      [
        file("src/lib/m/index.ts"),
        file("src/lib/m/core.ts"),
        file("src/lib/m/hidden.ts"),
        ...["u1", "u2", "u3"].map((u) => file(`src/app/${u}.ts`)),
        file("src/app/x.ts"),
      ],
      [
        edge("src/lib/m/index.ts", "src/lib/m/core.ts"),
        ...["u1", "u2", "u3"].map((u) => edge(`src/app/${u}.ts`, "src/lib/m/index.ts")),
      ],
    );
  }

  it("answers the report's verdict for an edge the graph does not hold — a first deep import past an adopted facade", () => {
    const graph = adoptedModuleGraph();
    const facts = deriveArchitectureComponentFacts(graph);
    const catalog = new ArchitectureFactsCatalog(facts, new Map(), new Set());

    expect(catalog.facadeLeakOf("src/app/x.ts", "src/lib/m/core.ts")).toEqual({
      moduleDir: "src/lib/m",
      facadeRelPath: "src/lib/m/index.ts",
      kind: "bypass",
    });
    expect(catalog.facadeLeakOf("src/app/x.ts", "src/lib/m/hidden.ts")?.kind).toBe("internal-reach");
    expect(catalog.facadeLeakOf("src/app/x.ts", "src/lib/m/index.ts")).toBeUndefined();
  });

  it("never answers for an endpoint the production graph was cut by — a test the report never judges", () => {
    const graph = adoptedModuleGraph();
    const nonProduction = { ignores: (relPath: string) => relPath.startsWith("tests/") };
    const facts = deriveArchitectureComponentFacts(graph, undefined, undefined, nonProduction);
    const catalog = new ArchitectureFactsCatalog(facts, new Map(), new Set());

    expect(catalog.facadeLeakOf("tests/app/x.test.ts", "src/lib/m/core.ts")).toBeUndefined();
    expect(catalog.facadeLeakOf("src/app/x.ts", "src/lib/m/core.ts")?.moduleDir).toBe("src/lib/m");
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
    return new ArchitectureFactsCatalog(facts, distances, measureLayeringFoundationFiles(graph, facts));
  }

  it("serves componentOf with the partition's name, instability, connectionCount and fan counts; a file outside the graph is undefined", () => {
    const catalog = catalogFixture();
    const app = catalog.componentOf("src/app/a.ts");
    const lib = catalog.componentOf("src/lib/b.ts");
    expect(app?.name).toBe("src/app");
    expect(lib?.name).toBe("src/lib");
    // lib Ce 1 / (Ca 0 + Ce 1); app Ca 1 / (Ca 1 + Ce 0).
    expect(lib?.instability).toBeCloseTo(1, 10);
    expect(app?.instability).toBeCloseTo(0, 10);
    // Ca + Ce per component — the count the diff run's small-N guard reads
    // (bd tea-rags-mcp-r8hme.45): both sit below the SDP floor here.
    expect(app?.connectionCount).toBe(1);
    expect(lib?.connectionCount).toBe(1);
    // The fan counts behind instability (bd tea-rags-mcp-89k7k.19): served
    // from the report's own ArchitectureComponent facts — the diff run's exact
    // I' = (Ce+k)/(Ca+Ce+k) recompute consumes them, never recomputes them.
    expect(app?.afferentCount).toBe(1);
    expect(app?.efferentCount).toBe(0);
    expect(lib?.afferentCount).toBe(0);
    expect(lib?.efferentCount).toBe(1);
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
      return new ArchitectureFactsCatalog(
        facts,
        distanceFromMainSequenceByComponent(facts.components, graph.files),
        measureLayeringFoundationFiles(graph, facts),
      );
    })();
    expect(pain.componentOf("rigid/x.ts")?.distanceFromMainSequence).toBeCloseTo(1, 10);
  });

  it("facadeOf is undefined for a directory component — only a measured module facade answers", () => {
    const catalog = catalogFixture();
    expect(catalog.facadeOf("src/app")).toBeUndefined();
    expect(catalog.facadeOf("no/such")).toBeUndefined();
  });

  // bd tea-rags-mcp-89k7k.1.19.11: the SDP preExisting read needs a component's
  // files; the catalog serves them off the same partition componentOf reads.
  it("filesOf answers the files the partition assigns to a component", () => {
    const graph = graphOf(
      [
        file("src/app/a.ts", { abstractTypeCount: 0, concreteTypeCount: 1 }),
        file("src/app/b.ts", { abstractTypeCount: 0, concreteTypeCount: 1 }),
        file("src/lib/c.ts", { abstractTypeCount: 0, concreteTypeCount: 1 }),
      ],
      [edge("src/app/a.ts", "src/lib/c.ts")],
    );
    const facts = deriveArchitectureComponentFacts(graph);
    const catalog = new ArchitectureFactsCatalog(facts, new Map(), new Set());
    const appComponent = catalog.componentOf("src/app/a.ts")?.name ?? "";

    expect([...catalog.filesOf(appComponent)].sort()).toEqual(["src/app/a.ts", "src/app/b.ts"]);
    expect(catalog.filesOf("no/such")).toEqual([]);
  });

  // bd tea-rags-mcp-89k7k.35.11: the diff run's foundationTerminal reads the
  // SAME measured foundation the whole-repo layering reports in summary.foundation —
  // abstractness 1 at L0 of the domain partition, never a directory name.
  it("isLayeringFoundation answers the measured layering foundation, not a path name", () => {
    const graph = graphOf(
      [
        file("src/app/a.ts", { abstractTypeCount: 0, concreteTypeCount: 5 }),
        file("src/spi/port.ts", { abstractTypeCount: 5, concreteTypeCount: 0 }),
        file("src/contracts/c.ts", { abstractTypeCount: 0, concreteTypeCount: 5 }),
      ],
      [edge("src/app/a.ts", "src/spi/port.ts"), edge("src/app/a.ts", "src/contracts/c.ts")],
    );
    const facts = deriveArchitectureComponentFacts(graph);
    const catalog = new ArchitectureFactsCatalog(
      facts,
      distanceFromMainSequenceByComponent(facts.components, graph.files),
      measureLayeringFoundationFiles(graph, facts),
    );

    expect(catalog.isLayeringFoundation("src/spi/port.ts")).toBe(true);
    expect(catalog.isLayeringFoundation("src/contracts/c.ts")).toBe(false);
    expect(catalog.isLayeringFoundation("src/app/a.ts")).toBe(false);
    expect(catalog.isLayeringFoundation("src/unwalked.ts")).toBe(false);
  });

  // bd tea-rags-mcp-r8hme.52.3: the whole-repo layering also exempts skips into
  // a foundation-terminal component — one whose every dependency lands in the
  // measured foundation — and the diff run's predicate answers the same set.
  it("isLayeringFoundation answers the foundation-terminal components the whole-repo layering exempts", () => {
    const concrete = { abstractTypeCount: 0, concreteTypeCount: 5 };
    const graph = graphOf(
      [
        file("src/app/a.ts", concrete),
        file("src/spi/port.ts", { abstractTypeCount: 5, concreteTypeCount: 0 }),
        file("src/kit/k.ts", concrete),
        file("src/kern/k.ts", concrete),
      ],
      [
        edge("src/kit/k.ts", "src/spi/port.ts"),
        edge("src/kern/k.ts", "src/spi/port.ts"),
        edge("src/kern/k.ts", "src/kit/k.ts"),
        edge("src/app/a.ts", "src/kern/k.ts"),
      ],
    );
    const facts = deriveArchitectureComponentFacts(graph);
    const catalog = new ArchitectureFactsCatalog(
      facts,
      distanceFromMainSequenceByComponent(facts.components, graph.files),
      measureLayeringFoundationFiles(graph, facts),
    );

    expect(catalog.isLayeringFoundation("src/kit/k.ts")).toBe(true);
    expect(catalog.isLayeringFoundation("src/kern/k.ts")).toBe(false);
    expect(catalog.isLayeringFoundation("src/app/a.ts")).toBe(false);
  });

  // bd tea-rags-mcp-89k7k.1.19.4: the diff run's hub reading leaves the SAME
  // foundation out of Ce that the catalog's foundation files name.
  it("measureLayeringFoundationAndTerminalComponents names the components measureLayeringFoundationFiles maps to files", () => {
    const concrete = { abstractTypeCount: 0, concreteTypeCount: 5 };
    const graph = graphOf(
      [
        file("src/app/a.ts", concrete),
        file("src/spi/port.ts", { abstractTypeCount: 5, concreteTypeCount: 0 }),
        file("src/kit/k.ts", concrete),
      ],
      [edge("src/kit/k.ts", "src/spi/port.ts"), edge("src/app/a.ts", "src/kit/k.ts")],
    );
    const facts = deriveArchitectureComponentFacts(graph);

    const components = measureLayeringFoundationAndTerminalComponents(graph, facts);
    expect([...components].sort()).toEqual(["src/kit", "src/spi"]);
    expect([...measureLayeringFoundationFiles(graph, facts, undefined, components)].sort()).toEqual([
      "src/kit/k.ts",
      "src/spi/port.ts",
    ]);
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

/**
 * The measured entry (bd tea-rags-mcp-r8hme.52.4): the diff run annotates
 * `entryPoint` / `compositionRoot` from the catalog, so the catalog serves the
 * report's own `entryFacade` fact — on the adoption partition too, where a
 * facade with too few importers to be judged is no module, yet still an entry.
 */
describe("ArchitectureFactsCatalog — entry facade", () => {
  it("serves entryFacade for a component holding a facade nothing imports, and omits it elsewhere", () => {
    const graph = graphOf(
      [file("src/tool/index.ts"), file("src/tool/run.ts"), file("src/lib/b.ts")],
      [edge("src/tool/index.ts", "src/tool/run.ts"), edge("src/tool/run.ts", "src/lib/b.ts")],
    );
    const facts = deriveArchitectureComponentFacts(graph);
    const catalog = new ArchitectureFactsCatalog(
      facts,
      distanceFromMainSequenceByComponent(facts.components, graph.files),
      measureLayeringFoundationFiles(graph, facts),
    );

    expect(catalog.componentOf("src/tool/run.ts")?.entryFacade).toBe(true);
    expect(catalog.componentOf("src/lib/b.ts")).not.toHaveProperty("entryFacade");
  });
});

/**
 * The measured composition evidence (bd tea-rags-mcp-r8hme.52.17): the diff
 * run annotates `parentSurface` / `compositionTable` from the catalog, so the
 * catalog serves the report's own facts — never a re-measurement.
 */
describe("ArchitectureFactsCatalog — composition evidence", () => {
  it("serves parentSurface and the composition-table files of the report's component graph", () => {
    const graph = graphOf(
      [file("web/w.ts"), file("billing/api/a.ts"), file("billing/ledger.ts")],
      [edge("web/w.ts", "billing/api/a.ts"), edge("billing/api/a.ts", "billing/ledger.ts")],
    );
    const facts = deriveArchitectureComponentFacts(graph);
    const tables = facts.components.compositionTables;
    if (!tables) throw new Error("fixture: composition tables not measured");
    facts.components.compositionTables = { ...tables, files: new Set(["web/w.ts"]) };
    const catalog = new ArchitectureFactsCatalog(
      facts,
      distanceFromMainSequenceByComponent(facts.components, graph.files),
      measureLayeringFoundationFiles(graph, facts),
    );

    expect(catalog.componentOf("billing/api/a.ts")?.parentSurface).toBe(true);
    expect(catalog.componentOf("web/w.ts")).not.toHaveProperty("parentSurface");
    expect(catalog.isCompositionTable("web/w.ts")).toBe(true);
    expect(catalog.isCompositionTable("billing/api/a.ts")).toBe(false);
  });
});

/**
 * One partition (bd tea-rags-mcp-r8hme.52.7): the diff run's catalog answers
 * on the same DOMAIN partition the whole-repo report's detectors judge — a
 * facade too few files import still owns its subtree there.
 */
describe("ArchitectureFactsCatalog — one partition", () => {
  it("attributes a file under a too-few-importers facade to that facade's component", () => {
    const graph = graphOf(
      [file("lang/index.ts"), file("lang/sub/s.ts"), file("app/main.ts")],
      [edge("app/main.ts", "lang/index.ts"), edge("lang/index.ts", "lang/sub/s.ts")],
    );
    const facts = deriveArchitectureComponentFacts(graph);
    const catalog = new ArchitectureFactsCatalog(
      facts,
      distanceFromMainSequenceByComponent(facts.components, graph.files),
      measureLayeringFoundationFiles(graph, facts),
    );

    expect(facts.leaks.modules.find((m) => m.moduleDir === "lang")?.status).toBe("too-few-importers");
    expect(catalog.componentOf("lang/sub/s.ts")?.name).toBe("lang");
  });
});
