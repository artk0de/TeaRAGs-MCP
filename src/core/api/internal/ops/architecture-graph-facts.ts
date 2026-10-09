/**
 * The architecture report's graph facts (bd tea-rags-mcp-89k7k.35.4): every
 * graph-DB read the detector set judges, taken ONCE into one immutable
 * snapshot by {@link readArchitectureGraphFacts}, so the detector run is pure
 * over it and never holds a `graphDb`. That is the seam 89k7k.1.7 judges a
 * diff through: read the base facts once, derive the overlaid facts with
 * {@link applyEdgeOverlay}, run the full detector set over both, and compare.
 *
 * History lookups (git commit counts, maintenance signals, a file's module
 * specifiers) stay lookups beside the facts: they are read lazily, only when a
 * detector's verdict can turn on them, and an edge overlay does not change
 * them.
 */

import type { ReviewFileEdge } from "../../../contracts/types/codegraph-storage.js";
import type {
  FileDependencyEdge,
  GraphDbClient,
  HierarchySnapshot,
  NonPublicMemberEdge,
  RelPath,
  TemporalCochangeGraph,
  TypeNameRow,
} from "../../../contracts/types/codegraph.js";
import { TYPE_DRAFT_KINDS } from "../../../domains/explore/naming-lexicon/index.js";
import { CONVENTION_PRIVACY_LANGUAGES } from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  readProductionArchitectureGraph,
  type DeclaredTestDependencyLookup,
  type IndexedFileImportLookup,
  type ProductionArchitectureGraph,
} from "./architecture-facts.js";
import { ontologyNonProductionPaths } from "./ontology-report-ops.js";

/**
 * The graph reads the report judges from. `loadHierarchySnapshot` is optional:
 * only the convention-privacy subclass exemption (bd tea-rags-mcp-r8hme.41)
 * reads it, and a reader without it judges every Python candidate as before.
 */
export type ArchitectureReportGraphDb = Pick<
  GraphDbClient,
  "readFileDependencyGraph" | "readNonPublicMemberEdges" | "readTemporalCochangeGraph" | "readTypeNameRows"
> &
  Partial<Pick<GraphDbClient, "loadHierarchySnapshot">>;

/**
 * The facts an edge overlay CANNOT refresh for its files — they keep the
 * index's reading, which may be stale for an overlaid file:
 *
 * - `memberEdges` / `classHierarchy`: the review read (F1) extracts file
 *   edges only, never resolved member calls or class ancestry, so convention
 *   privacy judges an overlaid file on its INDEXED member edges.
 * - `fileNodes`: the walked-file rows (language, symbol count, the
 *   type-abstractness census, outer scope names) — main sequence's
 *   abstractness and the namespace partition read the indexed census; a file
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
 * Every graph-DB read one architecture report judges, as one immutable value.
 * The detector run reads nothing else from the graph DB.
 */
export interface ArchitectureGraphFacts {
  /** The production file graph (bd tea-rags-mcp-r8hme.9) and what its read excluded. */
  readonly production: ProductionArchitectureGraph;
  /** Resolved method edges into convention-private members, unfiltered (scope filters at judge time). */
  readonly memberEdges: readonly NonPublicMemberEdge[];
  /** The class ancestry — read only when the reader has one and a Python member edge needs the exemption. */
  readonly classHierarchy?: HierarchySnapshot;
  /** The temporal co-change graph both temporal detectors read. */
  readonly cochange: TemporalCochangeGraph;
  /** The norms' type rows — present exactly when the request asked for norms. */
  readonly typeNameRows?: readonly TypeNameRow[];
  /** Present on facts {@link applyEdgeOverlay} derived; absent on the index's own facts. */
  readonly edgeOverlay?: ArchitectureEdgeOverlayState;
}

/**
 * The edge overlay {@link applyEdgeOverlay} reads — the shape of the review's
 * `ReviewEdgeOverlay`: every read file is masked; an unsupported read is
 * masked with no edges, and listed by `unsupported()`.
 */
export interface ArchitectureEdgeOverlaySource {
  readonly masked: ReadonlySet<string>;
  edgesFrom: (relPath: string) => readonly ReviewFileEdge[];
  unsupported: () => readonly { relPath: string; reason: string; detail?: string }[];
}

/**
 * Read every graph fact one report judges. Reads stay as lazy as the report
 * needed them: the type rows only when norms are asked, the hierarchy only
 * when a Python member edge can use the subclass exemption.
 */
export async function readArchitectureGraphFacts(
  graphDb: ArchitectureReportGraphDb,
  request: { norms?: boolean },
  readIndexedFileImports?: IndexedFileImportLookup,
  readDeclaredTestDependencies?: DeclaredTestDependencyLookup,
): Promise<ArchitectureGraphFacts> {
  // The read and the exclusions live in `architecture-facts.ts`, shared with
  // the diff-scoped run (bd tea-rags-mcp-89k7k.1.4).
  const production = await readProductionArchitectureGraph(
    graphDb,
    readIndexedFileImports,
    readDeclaredTestDependencies,
  );
  const memberEdges = await graphDb.readNonPublicMemberEdges([...CONVENTION_PRIVACY_LANGUAGES]);
  const classHierarchy =
    graphDb.loadHierarchySnapshot !== undefined && memberEdges.some((e) => e.targetLanguage === "python")
      ? await graphDb.loadHierarchySnapshot()
      : undefined;
  const cochange = await graphDb.readTemporalCochangeGraph();
  // The rows naming's role layer reads (whole project, production paths).
  const typeNameRows = request.norms
    ? await graphDb.readTypeNameRows({
        pathPrefixes: [],
        kinds: TYPE_DRAFT_KINDS,
        nonProductionPaths: ontologyNonProductionPaths(),
      })
    : undefined;
  return {
    production,
    memberEdges,
    ...(classHierarchy !== undefined ? { classHierarchy } : {}),
    cochange,
    ...(typeNameRows !== undefined ? { typeNameRows } : {}),
  };
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
export function applyEdgeOverlay(
  facts: ArchitectureGraphFacts,
  overlay: ArchitectureEdgeOverlaySource,
): ArchitectureGraphFacts {
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
