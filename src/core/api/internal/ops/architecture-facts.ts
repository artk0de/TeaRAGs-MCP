/**
 * The whole-repo report's derived FACTS (bd tea-rags-mcp-89k7k.1.4, F3 slice
 * 2): the production graph read, the component partition over the
 * leaking-abstraction facade classification, the main-sequence distance map,
 * and the instability band predicate — extracted out of
 * `architecture-report-ops.ts` so the diff-scoped detector run (F2's
 * `DiffDetectorRun`) consumes the SAME derivations the report judges through
 * instead of a copy. OWNED by the report (a fact changes only when the
 * report's judgement changes), CONSUMED by both the report and the
 * diff-scoped review; nothing here judges a diff — that is
 * `diff-detector-run.ts`'s layer.
 *
 * Move, not rewrite: the report re-points its call sites here and its
 * untouched suite is the regression gate. The one piece the report never
 * needed — the per-component main-sequence DISTANCE map and the catalog over
 * it — exists for the diff run alone and says so where it does.
 */

import type {
  FileDependencyGraph,
  FileDependencyGraphFile,
  GraphDbClient,
  RelPath,
} from "../../../contracts/types/codegraph.js";
import {
  buildComponentGraph,
  buildLayeringModel,
  classifyTestSupportFiles,
  DEFAULT_SDP_TOLERANCE,
  detectLeakingAbstractions,
  detectMainSequenceDeviations,
  excludeNonProductionFiles,
  measureLayeringFoundationComponents,
  measureLayeringFoundationTerminalComponents,
  resolveExternalImports,
  resolveUnwalkedImportEdges,
  type ComponentGraph,
  type IndexedFileImports,
  type LeakingAbstractionReport,
  type ProductionDependencyGraph,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import { buildNonProductionPathFilter, type PathFilter } from "../../../primitives/paths/index.js";
import type { DiffDetectorCatalog } from "./diff-detector-run.js";

/**
 * Every indexed file's declared module specifiers (`payload.imports`) and
 * whether it is a test, keyed by repo-relative path. The codegraph walks no
 * test, generated or policy-excluded file, so this is the only record of what
 * those import (bd tea-rags-mcp-89k7k.35.3).
 */
export type IndexedFileImportLookup = () => Promise<ReadonlyMap<RelPath, IndexedFileImports>>;

/**
 * The packages the addressed tree's manifests declare for development and
 * tests only (bd tea-rags-mcp-89k7k.35.3) — `package.json` `devDependencies`,
 * Gemfile `:development` / `:test` groups. A test-support classification input,
 * read from the working tree by the composition root.
 */
export type DeclaredTestDependencyLookup = () => ReadonlySet<string>;

/** What the test-support exclusion took out of the production graph. */
export interface TestSupportExclusionCounts {
  /** Walked files only tests and other test support import. */
  excludedFileCount: number;
  /** Edges with a test-support endpoint, left after the non-production exclusion. */
  excludedEdgeCount: number;
  /**
   * Distinct dependencies (packages, unwalked files) tests import and no
   * production file does — the positive evidence test support is tied to.
   */
  testOnlyDependencyCount: number;
}

/**
 * The production graph plus the filter that shaped it — the report re-uses the
 * filter for the member-edge privacy pass, so it names test support too.
 */
export interface ProductionArchitectureGraph extends ProductionDependencyGraph {
  nonProduction: PathFilter;
  testSupport: TestSupportExclusionCounts;
}

/**
 * Reads the indexed file dependency graph ONCE and applies the report's
 * non-production exclusion (bd tea-rags-mcp-r8hme.9) and then its test-support
 * exclusion (bd tea-rags-mcp-89k7k.35.3): every detector the report runs, and
 * every detector the diff-scoped run wires, judges THIS graph.
 *
 * Test support is derived from the import relation, not from names: a walked
 * file every importer of which is a test or test support AND which imports a
 * test-only dependency or other test support (`classifyTestSupportFiles`).
 * Importers are the graph's edges plus the resolved payload imports of the
 * files the codegraph does not walk (`resolveUnwalkedImportEdges`) — a test is
 * the only kind that makes support, a generated importer keeps its target
 * production; the dependencies are every indexed file's payload imports of
 * packages and unwalked files (`resolveExternalImports`). It is classified over the
 * graph BEFORE the non-production cut, so a script importing a file still
 * counts as a non-test importer. Without `readIndexedFileImports` no test
 * importer is known and nothing is classified.
 */
export async function readProductionArchitectureGraph(
  graphDb: Pick<GraphDbClient, "readFileDependencyGraph">,
  readIndexedFileImports?: IndexedFileImportLookup,
  readDeclaredTestDependencies?: DeclaredTestDependencyLookup,
): Promise<ProductionArchitectureGraph> {
  const indexed = await graphDb.readFileDependencyGraph();
  const nonProductionPaths = buildNonProductionPathFilter();
  const withoutTooling = excludeNonProductionFiles(indexed, nonProductionPaths);
  const { testSupport, testOnlyDependencyCount } = await classifyIndexedTestSupport(
    indexed,
    readIndexedFileImports,
    readDeclaredTestDependencies,
  );
  const testSupportPaths: PathFilter = { ignores: (relPath) => testSupport.has(relPath) };
  const production = excludeNonProductionFiles(withoutTooling.graph, testSupportPaths);
  return {
    graph: production.graph,
    excludedFileCount: withoutTooling.excludedFileCount,
    excludedEdgeCount: withoutTooling.excludedEdgeCount,
    testSupport: {
      excludedFileCount: production.excludedFileCount,
      excludedEdgeCount: production.excludedEdgeCount,
      testOnlyDependencyCount,
    },
    nonProduction: { ignores: (relPath) => nonProductionPaths.ignores(relPath) || testSupport.has(relPath) },
  };
}

/**
 * Test support over the whole indexed graph, and the size of the test-only
 * dependency set it rests on. Without `readIndexedFileImports` no test
 * importer is known and nothing is classified.
 */
async function classifyIndexedTestSupport(
  indexed: FileDependencyGraph,
  readIndexedFileImports: IndexedFileImportLookup | undefined,
  readDeclaredTestDependencies: DeclaredTestDependencyLookup | undefined,
): Promise<{ testSupport: ReadonlySet<RelPath>; testOnlyDependencyCount: number }> {
  if (!readIndexedFileImports) return { testSupport: new Set(), testOnlyDependencyCount: 0 };
  const importsByFile = await readIndexedFileImports();
  const walkedFiles = indexed.files.map((f) => f.relPath);
  const { files, testOnlyDependencies } = classifyTestSupportFiles(
    indexed,
    resolveUnwalkedImportEdges(importsByFile, walkedFiles),
    resolveExternalImports(importsByFile, walkedFiles),
    readDeclaredTestDependencies?.(),
  );
  return { testSupport: files, testOnlyDependencyCount: testOnlyDependencies.size };
}

/** The component partition with the facade classification it was built from. */
export interface ArchitectureComponentFacts {
  /** The facade classification (`leaks.modules`) — which directories are measured modules, which file is each one's facade. */
  leaks: LeakingAbstractionReport;
  /** The component map (bd tea-rags-mcp-r8hme.7): every module A4 assessed, namespaces or plain directories elsewhere — the one partition every component detector judges (bd tea-rags-mcp-r8hme.52.7). */
  components: ComponentGraph;
}

/**
 * The report's component partition over one graph: facade classification
 * first (adoption always counted over the whole graph handed in), components
 * built from its assessed modules. `sourcePathPattern` scopes only the leaks
 * REPORT's violations, never the partition — the same asymmetry
 * `detectLeakingAbstractions` documents. Moved verbatim from
 * `ArchitectureReportOps#build`; the report passes its request's
 * `pathPattern`, the diff run passes none.
 */
export function deriveArchitectureComponentFacts(
  graph: FileDependencyGraph,
  sourcePathPattern?: string,
): ArchitectureComponentFacts {
  const leaks = detectLeakingAbstractions(graph, { sourcePathPattern });
  return { leaks, components: buildComponentGraph(graph, leaks.modules) };
}

/**
 * Per-component distance from the main sequence, for the components the
 * report's own detector REPORTS (`detectMainSequenceDeviations`, default
 * options — no volatility gate: that gate only decides pain-zone REPORTING,
 * never D). A component the report never reported off the sequence carries
 * no entry — the catalog reads that as D=0, ON the sequence, so a diff's
 * delta over it is the distance the diff itself creates. Diff-run-only
 * surface: the report judges the main sequence through its own scoped,
 * volatility-gated call and never reads this map.
 */
export function distanceFromMainSequenceByComponent(
  components: ComponentGraph,
  files: readonly FileDependencyGraphFile[],
): ReadonlyMap<string, number> {
  return new Map(detectMainSequenceDeviations(components, files).violations.map((v) => [v.component, v.distance]));
}

/**
 * The files of the measured layering foundation (bd tea-rags-mcp-89k7k.35.11):
 * `measureLayeringFoundationComponents` over the SAME partition (`facts.components`
 * — the one partition every detector judges, bd tea-rags-mcp-r8hme.52.7) and
 * layering model the report's layering detector judges, mapped back to files —
 * the diff run addresses an edge's target by file. Diff-run-only surface: the
 * report reads the foundation off its layering summary. It carries the
 * foundation-terminal components too (bd tea-rags-mcp-r8hme.52.3,
 * `measureLayeringFoundationTerminalComponents`): exactly the set whose layer
 * skips the whole-repo layering exempts. `graph` is the graph `facts` was
 * derived from.
 */
export function measureLayeringFoundationFiles(
  graph: FileDependencyGraph,
  facts: ArchitectureComponentFacts,
): ReadonlySet<RelPath> {
  const { components } = facts;
  const model = buildLayeringModel(components);
  const foundations = measureLayeringFoundationComponents(components, graph.files, model);
  const terminals = measureLayeringFoundationTerminalComponents(components, model, foundations);
  const files = new Set<RelPath>();
  for (const [relPath, component] of components.componentOf) {
    if (foundations.has(component) || terminals.has(component)) files.add(relPath);
  }
  return files;
}

/**
 * The report's own instability band as a predicate: `leanedOnInstability` is
 * markedly less stable than `leaningInstability` when it sits beyond
 * `DEFAULT_SDP_TOLERANCE` — the exact comparison the report's
 * Stable-Dependencies detector flags (`I(target) − I(source) > tolerance`).
 * The 1e-9 epsilon mirrors the detector's `INSTABILITY_DELTA_EPSILON`
 * ("beyond the tolerance by more than rounding"): a delta exactly AT the
 * tolerance is a few ULPs either side of it, and the report does not flag it.
 */
export function isMarkedlyLessStableBySdpBand(leanedOnInstability: number, leaningInstability: number): boolean {
  return leanedOnInstability - leaningInstability > DEFAULT_SDP_TOLERANCE + INSTABILITY_BAND_ROUNDING_EPSILON;
}

/** The detectors' rounding margin on the band; mirrors their private epsilon. */
const INSTABILITY_BAND_ROUNDING_EPSILON = 1e-9;

/**
 * `DiffDetectorCatalog` over the extracted facts: components, facades and the
 * band exactly as the whole-repo report derived them — consumed by
 * `DiffDetectorRun`, never recomputed there. `facadeOf` answers only for a
 * MEASURED module component (a directory component has no facade); an absent
 * main-sequence distance reads 0 (see
 * {@link distanceFromMainSequenceByComponent}). `componentOf` also serves the
 * component's `connectionCount` — the count the diff run's small-N guard
 * judges against the SDP floor (bd tea-rags-mcp-r8hme.45) — and its Ca/Ce
 * fan counts (bd tea-rags-mcp-89k7k.19): the inputs of the diff run's exact
 * I' = (Ce+k)/(Ca+Ce+k) recompute, read straight off the report's
 * `ArchitectureComponent` facts, never recomputed here.
 */
export class ArchitectureFactsCatalog implements DiffDetectorCatalog {
  private readonly componentOfRelPath: ReadonlyMap<RelPath, string>;
  private readonly componentsByName: ComponentGraph["components"];
  private readonly facadeByComponent: ReadonlyMap<string, RelPath>;
  private readonly distances: ReadonlyMap<string, number>;
  private readonly layeringFoundationFiles: ReadonlySet<RelPath>;

  constructor(
    facts: ArchitectureComponentFacts,
    distances: ReadonlyMap<string, number>,
    layeringFoundationFiles: ReadonlySet<RelPath>,
  ) {
    this.layeringFoundationFiles = layeringFoundationFiles;
    this.componentOfRelPath = facts.components.componentOf;
    this.componentsByName = facts.components.components;
    this.facadeByComponent = new Map(
      [...facts.components.components]
        .map(([name, component]) => [name, component.facadeRelPath] as const)
        .filter((entry): entry is readonly [string, RelPath] => entry[1] !== null),
    );
    this.distances = distances;
  }

  componentOf(relPath: string):
    | {
        name: string;
        instability: number;
        distanceFromMainSequence: number;
        connectionCount: number;
        afferentCount?: number;
        efferentCount?: number;
        entryFacade?: true;
      }
    | undefined {
    const name = this.componentOfRelPath.get(relPath);
    if (name === undefined) return undefined;
    const component = this.componentsByName.get(name);
    if (component === undefined) return undefined;
    return {
      name,
      instability: component.instability,
      distanceFromMainSequence: this.distances.get(name) ?? 0,
      connectionCount: component.connectionCount,
      afferentCount: component.afferentCount,
      efferentCount: component.efferentCount,
      ...(component.entryFacade ? { entryFacade: true as const } : {}),
    };
  }

  facadeOf(componentName: string): string | undefined {
    return this.facadeByComponent.get(componentName);
  }

  isMarkedlyLessStable(leanOn: number, leanedOn: number): boolean {
    return isMarkedlyLessStableBySdpBand(leanOn, leanedOn);
  }

  isLayeringFoundation(relPath: string): boolean {
    return this.layeringFoundationFiles.has(relPath);
  }
}
