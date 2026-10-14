/**
 * Stable Dependencies Principle at COMPONENT level (bd tea-rags-mcp-r8hme.7):
 * I(source) ≥ I(target) judged on component dependencies, with a support
 * floor on each component's connection count; file edges ride along as the
 * evidence of which files carry the dependency.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectComponentStableDependencyViolations,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(
  sourceRelPath: string,
  targetRelPath: string,
  callWeight = 1,
  exportNames?: { importedExportNames?: string[]; reexportedExportNames?: string[] },
): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight, ...exportNames };
}

/** `count` files `${dir}/f{i}.ts`, each with an edge built by `link`. */
function files(dir: string, count: number, link: (relPath: string) => FileDependencyEdge) {
  const out: FileDependencyGraph = { files: [], edges: [] };
  for (let i = 1; i <= count; i++) {
    const relPath = `${dir}/f${i}.ts`;
    out.files.push(file(relPath));
    out.edges.push(link(relPath));
  }
  return out;
}

function merge(...parts: FileDependencyGraph[]): FileDependencyGraph {
  return { files: parts.flatMap((p) => p.files), edges: parts.flatMap((p) => p.edges) };
}

/**
 * `core/` (2 files, both importing `lib/`) — imported by 6 `app/` files:
 * Ca 6, Ce 2 → I = 2/8. `lib/` (5 files, each importing `vendor/`) — imported
 * by both core files and `other/o.ts`: Ca 3, Ce 5 → I = 5/8. core → lib runs
 * uphill by 3/8; `other/` (one file) is below the support floor.
 */
function stableCoreOnVolatileLib(): FileDependencyGraph {
  return merge(
    {
      files: [file("core/a.ts"), file("core/b.ts")],
      edges: [edge("core/a.ts", "lib/f1.ts", 2), edge("core/b.ts", "lib/f2.ts")],
    },
    files("app", 6, (p) => edge(p, "core/b.ts")),
    files("lib", 5, (p) => edge(p, "vendor/v.ts")),
    { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "lib/f3.ts")] },
  );
}

function judge(graph: FileDependencyGraph, options = {}) {
  return detectComponentStableDependencyViolations(buildComponentGraph(graph, []), options);
}

describe("detectComponentStableDependencyViolations", () => {
  it("flags a stable component depending on a less stable one, with component evidence and the file edges carrying it", () => {
    const report = judge(stableCoreOnVolatileLib());

    expect(report.violations).toEqual([
      {
        sourceComponent: "core",
        targetComponent: "lib",
        sourceInstability: 2 / 8,
        targetInstability: 5 / 8,
        instabilityDelta: 5 / 8 - 2 / 8,
        sourceAfferentCount: 6,
        sourceEfferentCount: 2,
        targetAfferentCount: 3,
        targetEfferentCount: 5,
        callWeight: 3,
        directoryRelation: "disjoint",
        fileEdgeCount: 2,
        fileEdges: [
          { sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts", callWeight: 2 },
          { sourceRelPath: "core/b.ts", targetRelPath: "lib/f2.ts", callWeight: 1 },
        ],
      },
    ]);
  });

  it("does not judge a component whose connection count is below the support floor", () => {
    const report = judge(stableCoreOnVolatileLib(), { minConnectionCount: 9 });

    expect(report.violations).toEqual([]);
    expect(report.summary.excluded.lowConnectionCount).toBeGreaterThan(0);
    expect(DEFAULT_SDP_MIN_CONNECTION_COUNT).toBe(5);
  });

  it("does not judge containment — a component depending on one nested inside it — but counts it", () => {
    // `core` depends on `core/volatile`, nested inside it: composition.
    const graph = merge(
      { files: [file("core/a.ts"), file("core/b.ts")], edges: [edge("core/a.ts", "core/volatile/f1.ts")] },
      files("app", 6, (p) => edge(p, "core/b.ts")),
      files("core/volatile", 5, (p) => edge(p, "vendor/v.ts")),
      { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "core/volatile/f3.ts")] },
    );

    const report = judge(graph);

    expect(report.violations).toEqual([]);
    expect(report.summary.excluded.containment).toBe(1);
  });

  it("groups violations by target component, most violations first", () => {
    const graph = merge(
      stableCoreOnVolatileLib(),
      {
        files: [file("base/a.ts")],
        edges: [edge("base/a.ts", "lib/f4.ts")],
      },
      files("users", 6, (p) => edge(p, "base/a.ts")),
    );

    const report = judge(graph);

    expect(report.rootCauses.map((r) => [r.targetComponent, r.violationCount, r.sources])).toEqual([
      ["lib", 2, ["base", "core"]],
    ]);
  });

  it("summarises the component graph and the component edges judged", () => {
    const report = judge(stableCoreOnVolatileLib());

    expect(report.summary).toMatchObject({
      tolerance: DEFAULT_SDP_TOLERANCE,
      minConnectionCount: DEFAULT_SDP_MIN_CONNECTION_COUNT,
      componentCount: 5,
      componentEdgeCount: 4,
      judgedEdgeCount: 3,
      violationCount: 1,
    });
  });

  it("judges only component dependencies carried by an in-scope source file", () => {
    const report = judge(stableCoreOnVolatileLib(), { sourcePathPattern: "other/**" });

    expect(report.violations).toEqual([]);
    expect(report.summary.scope).toEqual({ sourcePathPattern: "other/**", outOfScopeEdgeCount: 3 });
  });

  /**
   * The composition root assembles unstable concretes — that is its JOB — so
   * an SDP delta sourced from one is triage data, not a blind verdict (bd
   * tea-rags-mcp-r8hme.51, design on tea-rags-mcp-89k7k.9). Since bd
   * tea-rags-mcp-r8hme.52.4 the root is MEASURED — a component holding an
   * entry facade (`ArchitectureComponent.entryFacade`) — never a declared
   * path list: the user retired the declared lists, so a component at the
   * former declared path carries no annotation by its name alone.
   */
  describe("a violation sourced from a component holding an entry facade carries the annotation", () => {
    /**
     * Same uphill shape as `stableCoreOnVolatileLib`: `root/` holds a facade
     * nothing imports (`root/index.ts`) and two wiring files `root/app/` (its
     * own subtree, so not external to the module) depends on — Ca 6, Ce 2.
     */
    function entryRootOnVolatileLib(): FileDependencyGraph {
      return merge(
        {
          files: [file("root/index.ts"), file("root/a.ts"), file("root/b.ts")],
          edges: [
            edge("root/index.ts", "root/a.ts"),
            edge("root/a.ts", "lib/f1.ts", 2),
            edge("root/b.ts", "lib/f2.ts"),
          ],
        },
        files("root/app", 6, (p) => edge(p, "root/b.ts")),
        files("lib", 5, (p) => edge(p, "vendor/v.ts")),
        { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "lib/f3.ts")] },
      );
    }
    const entryRoot = {
      moduleDir: "root",
      facadeRelPath: "root/index.ts",
      externalImporterCount: 0,
      facadeImporterCount: 0,
      deepImporterCount: 0,
      adoption: 0,
      status: "too-few-importers" as const,
    };
    const judgeEntry = (graph: FileDependencyGraph) =>
      detectComponentStableDependencyViolations(buildComponentGraph(graph, [entryRoot]));

    it("stamps compositionRoot: true on the violation", () => {
      const report = judgeEntry(entryRootOnVolatileLib());

      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]?.sourceComponent).toBe("root");
      expect(report.violations[0]?.compositionRoot).toBe(true);
    });

    it("keeps the violation reported — annotated, never excluded", () => {
      const report = judgeEntry(entryRootOnVolatileLib());

      expect(report.summary.violationCount).toBe(1);
      expect(report.summary.judgedEdgeCount).toBeGreaterThan(0);
    });

    /** The same shape at the path the retired declared list named, with no entry facade. */
    function bootstrapOnVolatileLib(): FileDependencyGraph {
      return merge(
        {
          files: [file("src/bootstrap/a.ts"), file("src/bootstrap/b.ts")],
          edges: [
            edge("src/bootstrap/a.ts", "src/core/lib/f1.ts", 2),
            edge("src/bootstrap/b.ts", "src/core/lib/f2.ts"),
          ],
        },
        files("app", 6, (p) => edge(p, "src/bootstrap/b.ts")),
        files("src/core/lib", 5, (p) => edge(p, "vendor/v.ts")),
        { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "src/core/lib/f3.ts")] },
      );
    }

    it("names no root by path: the retired declared root's dir without an entry facade carries no annotation", () => {
      const report = judge(bootstrapOnVolatileLib());

      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]?.sourceComponent).toBe("src/bootstrap");
      expect("compositionRoot" in (report.violations[0] ?? {})).toBe(false);
    });

    it("leaves the field absent on a non-root source — not undefined-valued noise", () => {
      const report = judge(stableCoreOnVolatileLib());

      const violation = report.violations[0];
      expect(violation?.sourceComponent).toBe("core");
      expect("compositionRoot" in (violation ?? {})).toBe(false);
    });

    it("names no root by path for a dir nested under the retired declared root either", () => {
      const graph = merge(
        {
          files: [file("src/bootstrap/config/a.ts"), file("src/bootstrap/config/b.ts")],
          edges: [
            edge("src/bootstrap/config/a.ts", "src/core/lib/f1.ts", 2),
            edge("src/bootstrap/config/b.ts", "src/core/lib/f2.ts"),
          ],
        },
        files("app", 6, (p) => edge(p, "src/bootstrap/config/b.ts")),
        files("src/core/lib", 5, (p) => edge(p, "vendor/v.ts")),
        { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "src/core/lib/f3.ts")] },
      );

      const report = judge(graph);

      expect(report.violations[0]?.sourceComponent).toBe("src/bootstrap/config");
      expect("compositionRoot" in (report.violations[0] ?? {})).toBe(false);
    });
  });

  /**
   * callWeight 0 has four causes the weight alone cannot separate (a constant,
   * a type used as a value, a JSX element, a re-export — the
   * `FileDependencyEdge` docblock), so the evidence rows carry the export names
   * the edge's imports bind (bd tea-rags-mcp-89k7k.2). The shape below is the
   * live one that started the bead: api/public/app.ts imports the RUNTIME
   * `formatIndexDriftReport` plus the TYPE `IndexDriftReporter` from
   * maintenance/drift.
   */
  describe("evidence rows carry the file edge's export names", () => {
    /** Same uphill shape as `stableCoreOnVolatileLib`, one edge per name shape. */
    function graphWithNamedEdges(): FileDependencyGraph {
      return merge(
        {
          files: [file("core/plain.ts"), file("core/re.ts"), file("core/type.ts")],
          edges: [
            edge("core/plain.ts", "lib/f1.ts"),
            edge("core/re.ts", "lib/f2.ts", 0, { reexportedExportNames: ["formatIndexDriftReport"] }),
            edge("core/type.ts", "lib/f3.ts", 0, { importedExportNames: ["IndexDriftReporter"] }),
          ],
        },
        files("app", 6, (p) => edge(p, "core/plain.ts")),
        files("lib", 5, (p) => edge(p, "vendor/v.ts")),
        { files: [file("vendor/v.ts"), file("other/o.ts")], edges: [edge("other/o.ts", "lib/f4.ts")] },
      );
    }

    it("passes reexportedExportNames and importedExportNames through to the evidence rows", () => {
      const report = judge(graphWithNamedEdges());

      expect(report.violations[0]?.fileEdges).toEqual([
        { sourceRelPath: "core/plain.ts", targetRelPath: "lib/f1.ts", callWeight: 1 },
        {
          sourceRelPath: "core/re.ts",
          targetRelPath: "lib/f2.ts",
          callWeight: 0,
          reexportedExportNames: ["formatIndexDriftReport"],
        },
        {
          sourceRelPath: "core/type.ts",
          targetRelPath: "lib/f3.ts",
          callWeight: 0,
          importedExportNames: ["IndexDriftReporter"],
        },
      ]);
    });

    it("leaves both fields absent on an edge carrying neither — not undefined-valued noise", () => {
      const report = judge(graphWithNamedEdges());

      const plain = report.violations[0]?.fileEdges[0];
      expect(Object.keys(plain ?? {}).sort()).toEqual(["callWeight", "sourceRelPath", "targetRelPath"]);
    });
  });
});

/**
 * One partition for every component detector (bd tea-rags-mcp-r8hme.52.7):
 * SDP judges the DOMAIN partition the layering judges. A kernel whose facade
 * only its own vertical imports (`too-few-importers`) nested in a vertical
 * whose importers bypass the facade (`facade-not-adopted`) is its own
 * component — an edge into it is attributed to the kernel, never to the
 * volatile parent. On the self-index the narrower set made
 * `ts/walker → language` an SDP violation whose real target was the kernel.
 */
describe("detectComponentStableDependencyViolations — one partition (bd tea-rags-mcp-r8hme.52.7)", () => {
  function assessed(moduleDir: string, status: "facade-not-adopted" | "too-few-importers") {
    return {
      moduleDir,
      facadeRelPath: `${moduleDir}/index.ts`,
      externalImporterCount: 2,
      facadeImporterCount: 1,
      deepImporterCount: 1,
      adoption: 0.5,
      status,
    };
  }

  /**
   * `core/` (Ca 6, Ce 2 → I 1/4) reaches into `lang/kernel/`. `lang/` (5
   * files, each importing `vendor/`) is volatile; the kernel depends on
   * nothing — I 0.
   */
  function stableCoreOnNestedKernel(): FileDependencyGraph {
    return merge(
      {
        files: [file("core/a.ts"), file("core/b.ts"), file("lang/index.ts")],
        edges: [edge("core/a.ts", "lang/kernel/k.ts"), edge("core/b.ts", "lang/kernel/index.ts")],
      },
      files("app", 6, (p) => edge(p, "core/b.ts")),
      files("lang", 5, (p) => edge(p, "vendor/v.ts")),
      {
        files: [file("lang/kernel/index.ts"), file("lang/kernel/k.ts"), file("vendor/v.ts")],
        edges: [edge("lang/f1.ts", "lang/kernel/k.ts")],
      },
    );
  }
  const modules = [assessed("lang", "facade-not-adopted"), assessed("lang/kernel", "too-few-importers")];

  it("attributes an edge into a too-few-importers kernel to the kernel, not to its facade-not-adopted parent", () => {
    const components = buildComponentGraph(stableCoreOnNestedKernel(), modules);

    expect(components.componentOf.get("lang/kernel/k.ts")).toBe("lang/kernel");
    expect(components.dependencies.map((d) => `${d.sourceComponent} -> ${d.targetComponent}`)).toContain(
      "core -> lang/kernel",
    );
    const report = detectComponentStableDependencyViolations(components);
    expect(report.violations.map((v) => v.targetComponent)).not.toContain("lang");
  });
});

/**
 * A component whose every file is a pure re-export (bd tea-rags-mcp-ciq4d) has
 * no volatility of its own — it changes when its targets do. SDP judges an
 * edge INTO it as an edge into the ultimate target component, never judges
 * its own edges, and counts what it took out.
 */
describe("detectComponentStableDependencyViolations — re-export shim components are transparent (bd tea-rags-mcp-ciq4d)", () => {
  const EP = "src/core/api/entry-points";
  const PIPELINE = "src/core/domains/ingest/pipeline";
  const GIT = "src/core/domains/trajectory/git";
  const REGISTRY = "src/core/domains/maintenance/registry";
  const SYMBOLS = "src/core/domains/trajectory/codegraph/symbols";

  function shimFile(relPath: string) {
    return { relPath, language: "typescript", symbolCount: 0 };
  }

  function reexport(sourceRelPath: string, targetRelPath: string, names: string[]): FileDependencyEdge {
    return edge(sourceRelPath, targetRelPath, 0, { reexportedExportNames: names });
  }

  /** `dir/index.ts` plus `count - 1` siblings, each importing `vendor/v.ts`: Ce = count. */
  function volatileDomain(dir: string, count: number): FileDependencyGraph {
    const relPaths = [`${dir}/index.ts`, ...Array.from({ length: count - 1 }, (_, i) => `${dir}/f${i + 1}.ts`)];
    return { files: relPaths.map(file), edges: relPaths.map((p) => edge(p, "vendor/v.ts")) };
  }

  /** `dir/index.ts`, imported by `consumers/<name>/f{1..5}.ts`: Ce 0 → I 0. */
  function stableDomain(dir: string, name: string): FileDependencyGraph {
    return merge(
      { files: [file(`${dir}/index.ts`)], edges: [] },
      files(`consumers/${name}`, 5, (p) => edge(p, `${dir}/index.ts`)),
    );
  }

  /**
   * The pre-move `api/entry-points` shape (g3oo1, arch report a7075fbae): four
   * pure re-export files between `bootstrap/config` (Ca 6, Ce 2 → I 0.25)
   * plus the worker-pool factory, and four domain facades. entry-points: Ca 3,
   * Ce 3 → I 0.5; ingest/pipeline and trajectory/git: Ca 1, Ce 5 → I 5/6.
   * `poolSizingFile` builds `pool-sizing.ts` — a declaration there makes the
   * component opaque.
   */
  function preMoveEntryPoints(poolSizingFile: (relPath: string) => FileDependencyGraph["files"][number] = shimFile) {
    return merge(
      {
        files: [
          file("src/bootstrap/config/env-snapshot.ts"),
          file("src/bootstrap/config/schemas.ts"),
          file("src/bootstrap/codegraph-worker-pool-factory.ts"),
          shimFile(`${EP}/index.ts`),
          poolSizingFile(`${EP}/pool-sizing.ts`),
          shimFile(`${EP}/registry-env-replay.ts`),
          shimFile(`${EP}/codegraph-worker-pool.ts`),
          file("vendor/v.ts"),
        ],
        edges: [
          edge("src/bootstrap/config/env-snapshot.ts", `${EP}/index.ts`, 1, {
            importedExportNames: ["replayRegistryEnv"],
          }),
          edge("src/bootstrap/config/schemas.ts", `${EP}/index.ts`, 1, {
            importedExportNames: ["defaultBlamePoolSize"],
          }),
          edge("src/bootstrap/codegraph-worker-pool-factory.ts", `${EP}/codegraph-worker-pool.ts`, 1),
          reexport(`${EP}/index.ts`, `${EP}/pool-sizing.ts`, ["defaultBlamePoolSize"]),
          reexport(`${EP}/index.ts`, `${EP}/registry-env-replay.ts`, ["replayRegistryEnv"]),
          reexport(`${EP}/pool-sizing.ts`, `${PIPELINE}/index.ts`, ["defaultChunkerPoolSize"]),
          reexport(`${EP}/pool-sizing.ts`, `${GIT}/index.ts`, ["defaultBlamePoolSize"]),
          reexport(`${EP}/registry-env-replay.ts`, `${REGISTRY}/index.ts`, ["replayRegistryEnv"]),
          reexport(`${EP}/codegraph-worker-pool.ts`, `${SYMBOLS}/index.ts`, ["createCodegraphWorkerPool"]),
        ],
      },
      files("app", 6, (p) => edge(p, "src/bootstrap/config/schemas.ts")),
      volatileDomain(PIPELINE, 5),
      volatileDomain(GIT, 5),
      stableDomain(REGISTRY, "registry"),
      stableDomain(SYMBOLS, "symbols"),
    );
  }

  const pairsOf = (report: ReturnType<typeof judge>) =>
    report.violations.map((v) => `${v.sourceComponent} -> ${v.targetComponent}`);

  it("reports the pre-move shape's three entry-points findings while the component is opaque (control)", () => {
    const report = judge(preMoveEntryPoints(file));

    expect(pairsOf(report)).toEqual(
      expect.arrayContaining([`src/bootstrap/config -> ${EP}`, `${EP} -> ${PIPELINE}`, `${EP} -> ${GIT}`]),
    );
  });

  it("drops the three entry-points findings and counts the shim's dependencies as re-export shim exclusions", () => {
    const report = judge(preMoveEntryPoints());

    expect(pairsOf(report).filter((p) => p.includes(EP))).toEqual([]);
    expect(report.summary.reexportShimComponents).toEqual([EP]);
    // In: config -> ep, bootstrap -> ep. Out: ep -> pipeline / git / registry / symbols.
    expect(report.summary.excluded.reexportShimEdges).toBe(6);
  });

  it("judges an edge through the shim against the ULTIMATE target of the names it takes, with the real file edge as evidence", () => {
    const report = judge(preMoveEntryPoints());

    // schemas.ts takes defaultBlamePoolSize: index.ts -> pool-sizing.ts -> trajectory/git only.
    const throughShim = report.violations.find(
      (v) => v.sourceComponent === "src/bootstrap/config" && v.targetComponent === GIT,
    );
    expect(throughShim).toMatchObject({
      sourceInstability: 2 / 8,
      targetInstability: 5 / 6,
      instabilityDelta: 5 / 6 - 2 / 8,
      directoryRelation: "disjoint",
    });
    expect(throughShim?.fileEdges.map((e) => `${e.sourceRelPath} -> ${e.targetRelPath}`)).toEqual([
      `src/bootstrap/config/schemas.ts -> ${EP}/index.ts`,
    ]);
    // Nothing config takes reaches ingest/pipeline; the stable registry is judged and passes.
    expect(pairsOf(report)).not.toContain(`src/bootstrap/config -> ${PIPELINE}`);
    expect(pairsOf(report)).not.toContain(`src/bootstrap/config -> ${REGISTRY}`);
    // The worker-pool factory's edge records no names: the one per-file fallback.
    expect(report.summary.reexportShimNameUnknownEdges).toBe(1);
  });

  it("keeps a component holding one real declaration among its re-exports opaque", () => {
    const report = judge(preMoveEntryPoints(file));

    expect(report.summary.reexportShimComponents).toEqual([]);
    expect(report.summary.excluded.reexportShimEdges).toBe(0);
  });

  it("skips an edge that would resolve back into the source's own component", () => {
    const graph = merge(
      {
        files: [file("lib/a.ts"), file("lib/b.ts"), shimFile("shim/index.ts")],
        edges: [edge("lib/a.ts", "shim/index.ts"), reexport("shim/index.ts", "lib/b.ts", ["b"])],
      },
      files("app", 6, (p) => edge(p, "lib/a.ts")),
    );

    const report = judge(graph);

    expect(report.violations).toEqual([]);
    // lib -> shim (resolves back into lib) and shim -> lib; only app -> lib is judged.
    expect(report.summary.excluded.reexportShimEdges).toBe(2);
    expect(report.summary.judgedEdgeCount).toBe(1);
  });

  /**
   * Name-level resolution: an importer is linked only to the targets that
   * re-export the names it takes. Where the names cannot settle it — no names
   * on the importer edge, or a name no re-export of the shim forwards (an
   * alias: the walker records the SOURCE-side name) — the edge falls back to
   * every target behind the shim file, counted.
   */
  describe("follows the chain by the names the importer takes", () => {
    /** `core/` (Ca 6, Ce 1 → I 1/7) imports `shim/index.ts`, which re-exports `a` from x/ and `b` from y/ (both I 5/6). */
    function shimOverTwoTargets(importer: FileDependencyEdge, extraShimEdges: FileDependencyEdge[] = []) {
      return merge(
        {
          files: [file("core/c.ts"), shimFile("shim/index.ts"), file("vendor/v.ts")],
          edges: [
            importer,
            reexport("shim/index.ts", "x/index.ts", ["a"]),
            reexport("shim/index.ts", "y/index.ts", ["b"]),
            ...extraShimEdges,
          ],
        },
        files("app", 6, (p) => edge(p, "core/c.ts")),
        volatileDomain("x", 5),
        volatileDomain("y", 5),
        { files: [file("z/index.ts")], edges: [] },
      );
    }
    const targetsOf = (report: ReturnType<typeof judge>) =>
      report.violations.filter((v) => v.sourceComponent === "core").map((v) => v.targetComponent);

    it("links an importer taking only `a` to the target re-exporting `a`, not to the one re-exporting `b`", () => {
      const report = judge(shimOverTwoTargets(edge("core/c.ts", "shim/index.ts", 1, { importedExportNames: ["a"] })));

      expect(targetsOf(report)).toEqual(["x"]);
      expect(report.summary.reexportShimNameUnknownEdges).toBe(0);
    });

    it("passes a name through `export *` when no named re-export claims it", () => {
      const report = judge(
        shimOverTwoTargets(edge("core/c.ts", "shim/index.ts", 1, { importedExportNames: ["c"] }), [
          reexport("shim/index.ts", "z/index.ts", ["*"]),
        ]),
      );

      expect(report.violations.filter((v) => v.sourceComponent === "core")).toEqual([]);
      expect(report.summary.reexportShimNameUnknownEdges).toBe(0);
    });

    it("falls back to every target, counted, when the importer edge records no names", () => {
      const report = judge(shimOverTwoTargets(edge("core/c.ts", "shim/index.ts", 1)));

      expect(targetsOf(report).sort()).toEqual(["x", "y"]);
      expect(report.summary.reexportShimNameUnknownEdges).toBe(1);
    });

    it("falls back to every target, counted, when a taken name is forwarded by no re-export (an alias)", () => {
      const report = judge(
        shimOverTwoTargets(edge("core/c.ts", "shim/index.ts", 1, { importedExportNames: ["aAlias"] })),
      );

      expect(targetsOf(report).sort()).toEqual(["x", "y"]);
      expect(report.summary.reexportShimNameUnknownEdges).toBe(1);
    });
  });
});
