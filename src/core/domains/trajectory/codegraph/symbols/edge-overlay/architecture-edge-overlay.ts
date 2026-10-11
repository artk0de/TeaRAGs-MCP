/**
 * An edge overlay applied to the architecture report's graph facts (bd
 * tea-rags-mcp-89k7k.35.4, moved into the codegraph domain by bd
 * tea-rags-mcp-89k7k.35.19): each overlaid file's out-edges REPLACED by the
 * overlay's, every other file's indexed ones kept. Pure over its arguments —
 * the facts are read by the api's report runner, the overlay by whichever
 * producer built it; this module only derives the overlaid value.
 */

import type { ReviewFileEdge } from "../../../../../contracts/types/codegraph-storage.js";
import type { FileDependencyEdge, RelPath } from "../../../../../contracts/types/codegraph.js";
import type { PathFilter } from "../../../../../primitives/paths/index.js";
import type { ProductionDependencyGraph } from "../boundary-diagnostics/index.js";

/**
 * The facts an edge overlay CANNOT refresh for its files — they keep the
 * index's reading, which may be stale for an overlaid file:
 *
 * - `memberEdges` / `classHierarchy`: the review read (F1) extracts file
 *   edges only, never resolved member calls or class ancestry, so convention
 *   privacy judges an overlaid file on its INDEXED member edges.
 * - `fileNodes`: the walked-file rows (language, symbol count, the
 *   type-abstractness census, outer scope names, type heritage) — main
 *   sequence's abstractness and the namespace partition read the indexed
 *   census, and abstractionBypass's implementation evidence the indexed
 *   heritage (only the consumer's imported names move with the tree); a file
 *   the index never walked gets no node.
 * - `callWeight`: an overlay edge carries no resolved calls. A pair the index
 *   already held keeps its indexed weight, routed weight and import text; a
 *   new pair weighs 0.
 * - `cochange`: git history, which a working-tree edit does not change.
 * - `typeNameRows`: the norms' role layer reads the indexed type rows.
 * - `exclusionCounts`: which files are tooling or test support, and the
 *   summary counts of what that excluded, are the base read's.
 */
export type ArchitectureFactNotRefreshedByEdgeOverlay =
  | "memberEdges"
  | "classHierarchy"
  | "fileNodes"
  | "callWeight"
  | "cochange"
  | "typeNameRows"
  | "exclusionCounts";

/** Every {@link ArchitectureFactNotRefreshedByEdgeOverlay}, as the overlaid facts declare them. */
export const ARCHITECTURE_FACTS_NOT_REFRESHED_BY_EDGE_OVERLAY: readonly ArchitectureFactNotRefreshedByEdgeOverlay[] =
  Object.freeze([
    "memberEdges",
    "classHierarchy",
    "fileNodes",
    "callWeight",
    "cochange",
    "typeNameRows",
    "exclusionCounts",
  ]);

/** A file the overlay could not read edges for — its indexed edges stand, and a consumer reports it notJudged. */
export interface ArchitectureEdgeOverlayNotJudgedFile {
  relPath: RelPath;
  reason: string;
  detail?: string;
}

/** What an edge overlay changed in the facts it was applied to, and what it could not. */
export interface ArchitectureEdgeOverlayState {
  /** The files whose out-edges are now the overlay's. */
  refreshedFiles: ReadonlySet<RelPath>;
  /** The overlay's unsupported reads: base edges kept, judgement over them is NOT the tree's. */
  notJudgedFiles: readonly ArchitectureEdgeOverlayNotJudgedFile[];
  /** The facts no edge overlay refreshes — see {@link ArchitectureFactNotRefreshedByEdgeOverlay}. */
  notRefreshed: readonly ArchitectureFactNotRefreshedByEdgeOverlay[];
}

/**
 * The edge overlay {@link applyEdgeOverlay} reads — the shape of
 * `ReviewEdgeOverlay`: every read file is masked; an unsupported read is
 * masked with no edges, and listed by `unsupported()`.
 */
export interface ArchitectureEdgeOverlaySource {
  readonly masked: ReadonlySet<string>;
  edgesFrom: (relPath: string) => readonly ReviewFileEdge[];
  unsupported: () => readonly { relPath: string; reason: string; detail?: string }[];
}

/**
 * The part of the architecture graph facts an edge overlay rewrites: the
 * production file graph and the path filter its read excluded with. The
 * report's facts value carries more; {@link applyEdgeOverlay} keeps the rest.
 */
export interface ArchitectureEdgeOverlayTargetFacts {
  readonly production: ProductionDependencyGraph & { readonly nonProduction: PathFilter };
  readonly edgeOverlay?: ArchitectureEdgeOverlayState;
}

/**
 * The facts with each overlaid file's out-edges REPLACED by the overlay's —
 * the masking contract `DiffDetectorRun` documents: the overlay is the source
 * of truth for a read file's current out-edges, every other file keeps its
 * indexed ones. Pure: `facts` is never mutated.
 *
 * An unsupported read keeps its indexed edges and is listed in
 * `edgeOverlay.notJudgedFiles` — never treated as edge-free, never silently
 * as the tree. An overlay edge with a non-production endpoint is dropped, as
 * the production read drops it. What no edge overlay refreshes is declared on
 * the result (`edgeOverlay.notRefreshed`).
 */
export function applyEdgeOverlay<Facts extends ArchitectureEdgeOverlayTargetFacts>(
  facts: Facts,
  overlay: ArchitectureEdgeOverlaySource,
): Facts {
  const notJudgedFiles = overlay.unsupported().map(({ relPath, reason, detail }) => ({
    relPath,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  }));
  const notJudged = new Set(notJudgedFiles.map((f) => f.relPath));
  const refreshedFiles = new Set([...overlay.masked].filter((relPath) => !notJudged.has(relPath)));
  const { graph, nonProduction } = facts.production;
  const indexedByPair = new Map<string, FileDependencyEdge>();
  for (const edge of graph.edges) {
    if (refreshedFiles.has(edge.sourceRelPath)) indexedByPair.set(edgePairKey(edge), edge);
  }
  const overlaidEdges: FileDependencyEdge[] = graph.edges.filter((edge) => !refreshedFiles.has(edge.sourceRelPath));
  for (const relPath of refreshedFiles) {
    for (const edge of overlay.edgesFrom(relPath)) {
      if (nonProduction.ignores(edge.sourceRelPath) || nonProduction.ignores(edge.targetRelPath)) continue;
      overlaidEdges.push(overlayFileDependencyEdge(edge, indexedByPair.get(edgePairKey(edge))));
    }
  }
  return {
    ...facts,
    production: { ...facts.production, graph: { files: graph.files, edges: overlaidEdges } },
    edgeOverlay: { refreshedFiles, notJudgedFiles, notRefreshed: ARCHITECTURE_FACTS_NOT_REFRESHED_BY_EDGE_OVERLAY },
  };
}

function edgePairKey(edge: { sourceRelPath: string; targetRelPath: string }): string {
  return `${edge.sourceRelPath}\u0000${edge.targetRelPath}`;
}

/** One overlay edge as a file-graph edge: export names are the tree's, call weight and import text the index's. */
function overlayFileDependencyEdge(edge: ReviewFileEdge, indexed: FileDependencyEdge | undefined): FileDependencyEdge {
  return {
    sourceRelPath: edge.sourceRelPath,
    targetRelPath: edge.targetRelPath,
    callWeight: indexed?.callWeight ?? 0,
    ...(indexed?.frameworkRoutedCallWeight !== undefined
      ? { frameworkRoutedCallWeight: indexed.frameworkRoutedCallWeight }
      : {}),
    ...(indexed?.importText !== undefined ? { importText: indexed.importText } : {}),
    ...(edge.importedExportNames !== undefined ? { importedExportNames: [...edge.importedExportNames] } : {}),
    ...(edge.reexportedExportNames !== undefined ? { reexportedExportNames: [...edge.reexportedExportNames] } : {}),
  };
}
