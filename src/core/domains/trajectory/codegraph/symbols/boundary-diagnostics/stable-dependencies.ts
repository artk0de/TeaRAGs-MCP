import type { FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { CODEGRAPH_SYMBOLS_FILE_SIGNALS, type MartinInstability } from "../payload-signals.js";
import { classifyDirectoryRelation } from "./directory-relation.js";
import { computeFileInstabilities } from "./file-instability.js";
import type {
  StableDependenciesExclusionCounts,
  StableDependenciesOptions,
  StableDependenciesReport,
  StableDependencyViolation,
} from "./types.js";

/** Default `StableDependenciesOptions.tolerance`. */
export const DEFAULT_SDP_TOLERANCE = 0.2;

/**
 * What the no-symbol exclusion (`StableDependenciesExclusionCounts.noSymbolEndpoints`)
 * catches, named for a report: not only re-export barrels.
 */
export const NO_SYMBOL_ENDPOINT_REASON = "no-symbol endpoint: barrel, type-only or object-literal module";

/**
 * Default `StableDependenciesOptions.minConnectionCount`: the static
 * `confidence.score.threshold` the `codegraph.file.instability` descriptor
 * declares. At connectionCount 1 the ratio swings 0↔1 on a single edge; the
 * ranking dampens below this floor and the detector does not judge below it —
 * one declaration, read rather than restated, so the two cannot drift apart.
 */
export const DEFAULT_SDP_MIN_CONNECTION_COUNT: number = instabilityConfidenceFloor();

/**
 * Deltas are differences of ratios with different denominators, so a delta
 * that is exactly the tolerance can come out a few ULPs either side of it.
 * "Beyond the tolerance" means beyond it by more than rounding.
 */
const INSTABILITY_DELTA_EPSILON = 1e-9;

const NO_EDGES: MartinInstability = { instability: 0, connectionCount: 0 };

/**
 * Stable Dependencies Principle check (Martin): a module may depend only on
 * modules at least as stable as itself, i.e. I(source) ≥ I(target) on every
 * edge. Returns the edges where the target is LESS stable than the source by
 * more than the tolerance, most severe first.
 *
 * Judged on the file dependency graph `codegraph.file.instability` is counted
 * over, with that same instability (`computeFileInstabilities`). An edge is not
 * judged — and is counted under `summary.excluded` by the first reason that
 * applies — when:
 *
 * 1. it is a self-edge;
 * 2. an endpoint was never walked: the graph holds no fan-out for it, so its
 *    instability is an artifact of never having been extracted;
 * 3. either endpoint is a NO-SYMBOL file (`NO_SYMBOL_ENDPOINT_REASON`) — a
 *    walked file that defines no symbol and carries no call. The rule is aimed
 *    at the re-export barrel. Its instability describes no code of its own —
 *    its fanOut is its re-export count. As a SOURCE the barrel reads stable
 *    (its importers are really the dependents of what it re-exports) and every
 *    file it re-exports reads unstable by construction; as a TARGET it reads as
 *    unstable as its re-export count over its importers, which flags a consumer
 *    for using a module's public surface exactly as intended. Measured on
 *    tea-rags before the target side was excluded: 4 of 15 violations were a
 *    file importing a barrel, `mcp/tools/schemas.ts → core/api/public/index.ts`
 *    among them. The same criterion also matches a type-only module and a
 *    module whose code lives in an object literal (command handlers as object
 *    members), which have code of their own: on the self-index it took out
 *    276 of 1102 files and 891 of 2314 edges. Whether those belong is the SDP
 *    premise review's decision, so the report names every file it excluded
 *    (`noSymbolEndpointFiles`) instead of changing the criterion here;
 * 4. either endpoint's connectionCount is below `minConnectionCount`.
 *
 * Test files are not filtered here because they never reach the graph: the
 * codegraph exclusion filter keeps them out unconditionally.
 *
 * Severity is the delta alone — the principle is about the direction of
 * stability, not the volume of coupling; call weight only breaks ties, and is
 * reported so a reader can tell a one-call edge from a load-bearing one.
 */
export function detectStableDependencyViolations(
  graph: FileDependencyGraph,
  options: StableDependenciesOptions = {},
): StableDependenciesReport {
  const tolerance = options.tolerance ?? DEFAULT_SDP_TOLERANCE;
  const minConnectionCount = options.minConnectionCount ?? DEFAULT_SDP_MIN_CONNECTION_COUNT;
  const instabilities = computeFileInstabilities(graph);
  const walkedFiles = new Set<RelPath>(graph.files.map((f) => f.relPath));
  const noSymbolFiles = findNoSymbolFiles(graph);
  const excludedByNoSymbolFile = new Map<RelPath, number>();
  const excluded: StableDependenciesExclusionCounts = {
    selfEdges: 0,
    unwalkedEndpoints: 0,
    noSymbolEndpoints: 0,
    lowConnectionCount: 0,
  };
  const violations: StableDependencyViolation[] = [];
  let consideredEdgeCount = 0;

  for (const edge of graph.edges) {
    const source = instabilities.get(edge.sourceRelPath) ?? NO_EDGES;
    const target = instabilities.get(edge.targetRelPath) ?? NO_EDGES;
    if (edge.sourceRelPath === edge.targetRelPath) {
      excluded.selfEdges++;
    } else if (!walkedFiles.has(edge.sourceRelPath) || !walkedFiles.has(edge.targetRelPath)) {
      excluded.unwalkedEndpoints++;
    } else if (noSymbolFiles.has(edge.sourceRelPath) || noSymbolFiles.has(edge.targetRelPath)) {
      excluded.noSymbolEndpoints++;
      for (const endpoint of [edge.sourceRelPath, edge.targetRelPath]) {
        if (noSymbolFiles.has(endpoint)) {
          excludedByNoSymbolFile.set(endpoint, (excludedByNoSymbolFile.get(endpoint) ?? 0) + 1);
        }
      }
    } else if (source.connectionCount < minConnectionCount || target.connectionCount < minConnectionCount) {
      excluded.lowConnectionCount++;
    } else {
      consideredEdgeCount++;
      const instabilityDelta = target.instability - source.instability;
      if (instabilityDelta > tolerance + INSTABILITY_DELTA_EPSILON) {
        violations.push({
          sourceRelPath: edge.sourceRelPath,
          targetRelPath: edge.targetRelPath,
          sourceInstability: source.instability,
          targetInstability: target.instability,
          instabilityDelta,
          sourceConnectionCount: source.connectionCount,
          targetConnectionCount: target.connectionCount,
          callWeight: edge.callWeight,
          directoryRelation: classifyDirectoryRelation(edge.sourceRelPath, edge.targetRelPath),
        });
      }
    }
  }

  violations.sort(bySeverity);
  return {
    violations,
    summary: {
      tolerance,
      minConnectionCount,
      edgeCount: graph.edges.length,
      consideredEdgeCount,
      violationCount: violations.length,
      excluded,
    },
    noSymbolEndpointFiles: [...excludedByNoSymbolFile]
      .map(([relPath, excludedEdgeCount]) => ({ relPath, excludedEdgeCount }))
      .sort((a, b) => b.excludedEdgeCount - a.excludedEdgeCount || compareCodePoints(a.relPath, b.relPath)),
  };
}

/** Walked files that define no symbol and carry no outgoing call. */
function findNoSymbolFiles(graph: FileDependencyGraph): Set<RelPath> {
  const outgoingCallWeight = new Map<RelPath, number>();
  for (const edge of graph.edges) {
    outgoingCallWeight.set(edge.sourceRelPath, (outgoingCallWeight.get(edge.sourceRelPath) ?? 0) + edge.callWeight);
  }
  const noSymbol = new Set<RelPath>();
  for (const file of graph.files) {
    if (file.symbolCount === 0 && (outgoingCallWeight.get(file.relPath) ?? 0) === 0) noSymbol.add(file.relPath);
  }
  return noSymbol;
}

function bySeverity(a: StableDependencyViolation, b: StableDependencyViolation): number {
  return (
    b.instabilityDelta - a.instabilityDelta ||
    b.callWeight - a.callWeight ||
    compareCodePoints(a.sourceRelPath, b.sourceRelPath) ||
    compareCodePoints(a.targetRelPath, b.targetRelPath)
  );
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function instabilityConfidenceFloor(): number {
  const threshold = CODEGRAPH_SYMBOLS_FILE_SIGNALS.find((d) => d.key === "codegraph.file.instability")?.stats
    ?.confidence?.score?.threshold;
  if (threshold === undefined) {
    // Invariant, not input: the descriptor ships in this module's own trajectory.
    throw new Error("codegraph.file.instability declares no confidence.score.threshold");
  }
  return threshold;
}
