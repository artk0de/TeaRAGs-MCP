/**
 * Diff-run fixture builders shared by `diff-detector-run.test.ts` and the
 * per-family tests under `diff-families/` (moved verbatim from the run test,
 * bd tea-rags-mcp-89k7k.1.19.2). Every fixture is a plain Map — no DuckDB, no
 * temp repositories, no index.
 */
import {
  DiffDetectorRun,
  type DiffDetectorBaseEdgeReader,
  type DiffDetectorCatalog,
  type DiffDetectorFindings,
  type DiffDetectorGraphReader,
  type DiffDetectorSilentCouplingFacts,
  type DiffDetectorSplitMergeReader,
} from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import { ReviewEdgeOverlay } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

/** A file edge as a fixture tuple. */
export type FixtureEdge = readonly [source: string, target: string];

/** The report's markedly-less-stable band, stubbed at a 0.3 tolerance. */
const MARKEDLY_LESS_STABLE_TOLERANCE = 0.3;

/** Indexed-graph reader over plain edge tuples: forward and reverse indices. */
export function graphOf(edges: readonly FixtureEdge[]): DiffDetectorGraphReader {
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

/** One component's facts as the catalog serves them — the port's own shape, so fixtures cannot drift from it. */
export type ComponentFact = NonNullable<ReturnType<DiffDetectorCatalog["componentOf"]>>;

/**
 * The `connectionCount` a fixture carries when it states none — above the SDP
 * floor (`DEFAULT_SDP_MIN_CONNECTION_COUNT`), so an existing fixture's verdict
 * rests on its instability alone; the below-floor cases state their own.
 */
const ABOVE_CONNECTION_FLOOR = 10;

/** Report-derived component/facade facts keyed the way the catalog serves them. */
export function catalogOf(
  components: ReadonlyMap<
    string,
    Omit<ComponentFact, "connectionCount"> & Partial<Pick<ComponentFact, "connectionCount">>
  >,
  facades: ReadonlyMap<string, string> = new Map(),
  layeringFoundationFiles: ReadonlySet<string> = new Set(),
): DiffDetectorCatalog {
  return {
    componentOf: (relPath) => {
      const fact = components.get(relPath);
      return fact === undefined
        ? undefined
        : { ...fact, connectionCount: fact.connectionCount ?? ABOVE_CONNECTION_FLOOR };
    },
    filesOf: (componentName) =>
      [...components].filter(([, fact]) => fact.name === componentName).map(([relPath]) => relPath),
    facadeOf: (componentName) => facades.get(componentName),
    isMarkedlyLessStable: (leanOn, leanedOn) => leanOn - leanedOn >= MARKEDLY_LESS_STABLE_TOLERANCE,
    isLayeringFoundation: (relPath) => layeringFoundationFiles.has(relPath),
  };
}

/** The review's overlay: one read per changed file, its edges picked from the tuples. */
export function overlayOf(edges: readonly FixtureEdge[], changed: readonly string[]): ReviewEdgeOverlay {
  return new ReviewEdgeOverlay(
    changed.map((relPath) => ({
      relPath,
      edges: edges
        .filter(([source]) => source === relPath)
        .map(([sourceRelPath, targetRelPath]) => ({ sourceRelPath, targetRelPath })),
    })),
  );
}

export function runWith(
  deps: {
    graph?: DiffDetectorGraphReader;
    catalog?: DiffDetectorCatalog;
    silentCouplingFacts?: DiffDetectorSilentCouplingFacts;
    splitMerge?: DiffDetectorSplitMergeReader;
    splitMergeAbsentReason?: string;
    maxTraceHops?: number;
    baseEdges?: DiffDetectorBaseEdgeReader;
  },
  changedFiles: readonly string[],
  overlayEdges: readonly FixtureEdge[],
): DiffDetectorFindings {
  const run = new DiffDetectorRun({
    graph: deps.graph ?? graphOf([]),
    catalog: deps.catalog ?? catalogOf(new Map()),
    ...(deps.silentCouplingFacts !== undefined ? { silentCouplingFacts: deps.silentCouplingFacts } : {}),
    ...(deps.splitMerge !== undefined ? { splitMerge: deps.splitMerge } : {}),
    ...(deps.splitMergeAbsentReason !== undefined ? { splitMergeAbsentReason: deps.splitMergeAbsentReason } : {}),
    ...(deps.maxTraceHops !== undefined ? { maxTraceHops: deps.maxTraceHops } : {}),
    ...(deps.baseEdges !== undefined ? { baseEdges: deps.baseEdges } : {}),
  });
  return run.run({ changedFiles }, overlayOf(overlayEdges, changedFiles));
}

/**
 * The diff base's edges per changed source, as the wiring reads them from the
 * merge-base blobs: a listed source maps to the targets it imported AT THE
 * BASE (empty = absent or import-free there); an unlisted source answers
 * undefined — base unknown, the index decides. `surfaces` is the same map for
 * the names each source re-exported at the base (bd tea-rags-mcp-2plk2); an
 * unlisted source's surface is unknown.
 */
export function baseEdgesOf(
  bySource: Readonly<Record<string, readonly string[]>>,
  surfaces: Readonly<Record<string, readonly string[]>> = {},
): DiffDetectorBaseEdgeReader {
  return {
    targetsAtBase: (relPath) => (relPath in bySource ? new Set(bySource[relPath]) : undefined),
    reexportSurfaceAtBase: (relPath) => (relPath in surfaces ? new Set(surfaces[relPath]) : undefined),
  };
}

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
