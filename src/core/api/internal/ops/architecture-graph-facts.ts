/**
 * The architecture report's graph facts (bd tea-rags-mcp-89k7k.35.4): every
 * graph-DB read the detector set judges, taken ONCE into one immutable
 * snapshot by {@link readArchitectureGraphFacts}, so the detector run is pure
 * over it and never holds a `graphDb`. That is the seam 89k7k.1.7 judges a
 * diff through: read the base facts once, derive the overlaid facts with
 * `applyEdgeOverlay` (the codegraph domain owns it, bd tea-rags-mcp-89k7k.35.19),
 * run the full detector set over both, and compare.
 *
 * History lookups (git commit counts, maintenance signals, a file's module
 * specifiers) stay lookups beside the facts: they are read lazily, only when a
 * detector's verdict can turn on them, and an edge overlay does not change
 * them.
 */

import type {
  GraphDbClient,
  HierarchySnapshot,
  NonPublicMemberEdge,
  RelPath,
  TemporalCochangeGraph,
  TypeNameRow,
} from "../../../contracts/types/codegraph.js";
import { TYPE_DRAFT_KINDS } from "../../../domains/explore/naming-lexicon/index.js";
import {
  CONVENTION_PRIVACY_LANGUAGES,
  type ArchitectureEdgeOverlayState,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  readProductionArchitectureGraph,
  type DeclaredTestDependencyLookup,
  type IndexedFileImportLookup,
  type ProductionArchitectureGraph,
  type TreeFileTextLookup,
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
  /** Present on facts `applyEdgeOverlay` derived; absent on the index's own facts. */
  readonly edgeOverlay?: ArchitectureEdgeOverlayState;
  /** Present on facts `applyArchitectureRestructure` derived: the component each relabelled file is pinned to. */
  readonly componentRelabel?: ReadonlyMap<RelPath, string>;
}

/**
 * The type rows the dependency norms read roles from — the rows naming's role
 * layer reads (whole project, production paths). One query for the report's
 * norms and the planned-edge verdict (bd tea-rags-mcp-xb669.2).
 */
export async function readDependencyNormTypeNameRows(
  graphDb: Pick<GraphDbClient, "readTypeNameRows">,
): Promise<readonly TypeNameRow[]> {
  return graphDb.readTypeNameRows({
    pathPrefixes: [],
    kinds: TYPE_DRAFT_KINDS,
    nonProductionPaths: ontologyNonProductionPaths(),
  });
}

/**
 * Read every graph fact one report judges. Reads stay as lazy as the report
 * needed them: the type rows only when norms are asked, the hierarchy only
 * when a Python member edge can use the subclass exemption.
 */
export async function readArchitectureGraphFacts(
  graphDb: ArchitectureReportGraphDb,
  request: {
    norms?: boolean;
    /** A co-change snapshot the caller already read — taken as is instead of read again. */
    cochange?: TemporalCochangeGraph;
    /**
     * A production graph the caller already reads (bd tea-rags-mcp-pqdw4) —
     * the review's one shared read — awaited instead of read again.
     */
    production?: Promise<ProductionArchitectureGraph>;
  },
  readIndexedFileImports?: IndexedFileImportLookup,
  readDeclaredTestDependencies?: DeclaredTestDependencyLookup,
  readTreeFileText?: TreeFileTextLookup,
): Promise<ArchitectureGraphFacts> {
  // The read and the exclusions live in `architecture-facts.ts`, shared with
  // the diff-scoped run (bd tea-rags-mcp-89k7k.1.4). The member edges are
  // read beside the production graph, not after it (bd tea-rags-mcp-pqdw4).
  const [production, memberEdges] = await Promise.all([
    request.production ??
      readProductionArchitectureGraph(graphDb, readIndexedFileImports, readDeclaredTestDependencies, readTreeFileText),
    graphDb.readNonPublicMemberEdges([...CONVENTION_PRIVACY_LANGUAGES]),
  ]);
  const classHierarchy =
    graphDb.loadHierarchySnapshot !== undefined && memberEdges.some((e) => e.targetLanguage === "python")
      ? await graphDb.loadHierarchySnapshot()
      : undefined;
  const cochange = request.cochange ?? (await graphDb.readTemporalCochangeGraph());
  const typeNameRows = request.norms ? await readDependencyNormTypeNameRows(graphDb) : undefined;
  return {
    production,
    memberEdges,
    ...(classHierarchy !== undefined ? { classHierarchy } : {}),
    cochange,
    ...(typeNameRows !== undefined ? { typeNameRows } : {}),
  };
}
