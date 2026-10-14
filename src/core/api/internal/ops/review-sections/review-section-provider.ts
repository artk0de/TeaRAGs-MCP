/**
 * The review-section port (bd tea-rags-mcp-89k7k.1.4, F3): one diff-scoped
 * report behind one id. Sections are independent providers — adding one must
 * not touch the others — and the orchestration (`ReviewChangesOps`) knows them
 * only through this interface: `isBuilt` decides from the build context, `run`
 * answers over the run context. The MCP enum is derived from the live provider
 * registry, so an id whose provider has not shipped fails loud at the boundary.
 *
 * Absence contract: a section's missing substrate is `built: false` with a
 * reason — never an exception, never a silent empty answer; a file the section
 * could not judge is a `notJudged` entry, never a zero.
 */

import type { GitFileMaintenanceSignals } from "../../../../contracts/types/architecture-report.js";
import type { GraphDbClient, RelPath, TemporalCochangeGraph } from "../../../../contracts/types/codegraph.js";
import type { ReviewEdgeOverlay } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { ReviewSectionId } from "../../../public/dto/review.js";
import type {
  DeclaredTestDependencyLookup,
  IndexedFileImportLookup,
  ProductionArchitectureGraph,
} from "../architecture-facts.js";
import type { ArchitectureReportGraphDb } from "../architecture-graph-facts.js";
import type { DiffDetectorBaseEdgeReader } from "../diff-families/diff-family-detector.js";
import type { DiffScopeRead, DiffScopeRequest, DiffTreeLag } from "../diff-scope-reader.js";
import type { NamingLexiconOps } from "../naming-lexicon-ops.js";
import type { ReviewEdgeExtractionDeps } from "../review-edge-overlay.js";

/**
 * The indexed graph reads a review section may perform: the temporal
 * sub-graph's two reads, plus every read the whole-repo report judges from
 * (`ArchitectureReportGraphDb` — the `architecture` section runs the full
 * detector set over the index and over the overlaid tree, bd
 * tea-rags-mcp-89k7k.1.7).
 */
export type ReviewGraphDb = Pick<GraphDbClient, "readTemporalCochangeGraph" | "readTemporalSymbolCommits"> &
  ArchitectureReportGraphDb;

/** The naming lexicon operations, as a review section needs them. */
export type ReviewNamingLexicon = Pick<NamingLexiconOps, "getNamingLexicon">;

/**
 * What a section needs to DECIDE whether it can build. Assembled once per
 * review by the orchestration while the codegraph reader is open — the only
 * expensive read here (`temporalCochange`) is performed when a section that
 * may need it was requested.
 */
export interface ReviewSectionBuildContext {
  /** The change under review, as the F0 reader read it. */
  scope: DiffScopeRead;
  /**
   * The index's lag behind the reviewed tree's HEAD (`readTreeLag`), absent
   * when they agree or either is unknown — the `architecture` section's base
   * IS the index, so a lag can put already-committed changes in "introduced".
   */
  indexLag?: DiffTreeLag;
  /** The acquired indexed-graph reader; `undefined` when the collection has no codegraph database. */
  graphDb: ReviewGraphDb | undefined;
  /**
   * The indexed temporal co-change graph, read once for a review that asked
   * for a section consuming it: `null` = no build has run, `undefined` = not
   * read for this review.
   */
  temporalCochange: TemporalCochangeGraph | null | undefined;
  /** Why the temporal graph could not be read, when it could not. */
  temporalCochangeError: string | undefined;
  /** The naming lexicon operations; `undefined` when not wired (codegraph off). */
  lexiconOps: ReviewNamingLexicon | undefined;
  /**
   * The working-tree edge extraction trio (languageFactory + collectSymbols +
   * composer) the `architecture` section walks changed files with — the same
   * wires `createNamingReviewExtractor` uses; `undefined` when not wired.
   */
  reviewEdgeExtraction: ReviewEdgeExtractionDeps | undefined;
  /**
   * The change's edges on both sides (`readReviewChangeEdges`), read once per
   * review and shared by every section that walks the diff (bd
   * tea-rags-mcp-nehn5): the walk, the symbol table hydrated from the index's
   * rows (bd tea-rags-mcp-vdhjc) and the base read run once, not once per
   * section — the overlay and the base reader are immutable. Absent (unit
   * wiring) → the section reads them itself with no indexed rows, so the
   * table-reading languages skip with the reason.
   */
  readReviewChangeEdges?: () => Promise<ReviewChangeEdges>;
  /**
   * The indexed payload's import specifiers per file (bd tea-rags-mcp-2wsnt)
   * — the SAME read the whole-repo report's second silent-coupling pass uses
   * (`readPayloadImportSpecifiers`, bd tea-rags-mcp-rbnkp), bound to this
   * review's collection. The `architecture` section asks it only about the
   * walked endpoints of diff-touching one-walked violations, so its cost is
   * bounded by the diff, never by the graph. Absent (unit wiring) → the
   * section's silent-coupling facts are the single-pass verdict.
   */
  readImportSpecifiers?: (relPaths: readonly RelPath[]) => Promise<ReadonlyMap<RelPath, readonly string[]>>;
  /**
   * Every file's git maintenance readings (bd tea-rags-mcp-r8hme.20) — the
   * SAME read the whole-repo report ranks its violations by
   * (`readPayloadFileMaintenanceSignals`), bound to this review's collection.
   * The `architecture` section reads it once, only when it has findings to
   * rank. Absent (unit wiring) → findings list in the run's order, untagged.
   */
  readFileMaintenanceSignals?: () => Promise<ReadonlyMap<RelPath, GitFileMaintenanceSignals>>;
  /**
   * Every indexed file's module specifiers (and whether it is a test) (bd tea-rags-mcp-89k7k.35.3) — the
   * SAME read the whole-repo report derives test support from
   * (`readPayloadIndexedFileImports`), bound to this review's
   * collection. The `architecture` section reads it once with the production
   * graph. Absent (unit wiring) → no test support is excluded.
   */
  readIndexedFileImports?: IndexedFileImportLookup;
  /**
   * The development-only packages the reviewed tree's manifests declare (bd
   * tea-rags-mcp-89k7k.35.3), evidence for the same test-support exclusion.
   * Absent → the manifests add nothing.
   */
  readDeclaredTestDependencies?: DeclaredTestDependencyLookup;
  /**
   * The production graph (`readProductionArchitectureGraph` over this review's
   * `graphDb` and the two lookups above), read on first use and shared by the
   * `architecture` and `norms` sections (bd tea-rags-mcp-pqdw4): one whole-graph
   * read, one whole-index import read, one manifest read per review. Consumers
   * never mutate it. Absent (unit wiring) → each section reads its own.
   */
  readProductionGraph?: () => Promise<ProductionArchitectureGraph>;
}

/**
 * The change's edges on both sides: the working tree's reads of the scope
 * files, and the diff base's targets of the same files.
 */
export interface ReviewChangeEdges {
  overlay: ReviewEdgeOverlay;
  baseEdges: DiffDetectorBaseEdgeReader | undefined;
}

/** What a section needs to ANSWER, once it has decided it can build. */
export interface ReviewSectionContext extends ReviewSectionBuildContext {
  /** The request's addressing, forwarded so a section can address the index itself. */
  addressing: { project?: string; collection?: string; path?: string };
  /** The collection the index reads address — never the worktree path. */
  collectionName: string;
  /**
   * The temporal walk's history window (the git trajectory's
   * `chunkMaxAgeMonths`) — the stated limit of every cohesion number.
   */
  windowMonths: number;
  /** The diff request as the caller sent it — what a section that re-reads the diff forwards. */
  diffRequest: DiffScopeRequest;
}

/** One diff-scoped report provider. */
export interface ReviewSectionProvider {
  readonly id: ReviewSectionId;
  /**
   * This section consumes the pre-read temporal co-change snapshot, so the
   * orchestration reads it once for a review that requested ANY such section —
   * `incompleteChange` and `architecture` today. Absent = never read for this
   * review's sake.
   */
  readonly consumesTemporalCochange?: boolean;
  /**
   * This section walks the diff's edges (`readReviewChangeEdges`), so the
   * orchestration starts the index's symbol-row read as soon as the graph
   * reader is open, overlapping the diff read (bd tea-rags-mcp-nehn5). Absent
   * = no rows are read for this review's sake.
   */
  readonly consumesReviewChangeEdges?: boolean;
  /**
   * Decide from the build context; `{ built: false, reason }` when the
   * substrate is missing. Never throws, never reads.
   */
  isBuilt: (context: ReviewSectionBuildContext) => { built: boolean; reason?: string };
  /**
   * Answer over the run context: the section's payload fields (plus its own
   * `notJudged`, which the envelope carries). Called only when `isBuilt`
   * said built — but a provider stays total and may still answer
   * `{ built: false, reason }` for a substrate that failed at run time.
   */
  run: (context: ReviewSectionContext) => Promise<unknown>;
}
