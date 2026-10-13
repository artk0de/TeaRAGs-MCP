/**
 * The `architecture` review section (bd tea-rags-mcp-89k7k.1.4, F3 slice 2):
 * the wiring of F2's `DiffDetectorRun` to the REAL substrate — the indexed
 * graph and the whole-repo report's extracted facts (`architecture-facts.ts`)
 * on one side, F1's working-tree edges (`readWorkingTreeFileEdges` →
 * `ReviewEdgeOverlay`) on the other. This section owns NO judgement: the
 * detectors are `DiffDetectorRun`'s, the facts are the report's; what lives
 * here is the RUN FLOW and the per-review temp table's guaranteed cleanup.
 *
 * Temp-table lifecycle (the F1 storage rule): sweep-on-create, ONE minted
 * reviewId, the successful edges put once, and a finally-DROP on success AND
 * error — a drop failure never masks the original result or error (the
 * age-sweep backstop collects what a failed drop leaves). The table holds
 * ONLY the review's working-tree edges; masking of a changed file's indexed
 * edges is `DiffDetectorRun`'s job (its docblock's masking contract), so a
 * skipped file still masks correctly through the scope.
 *
 * The co-change snapshot arrives PRE-READ in the build context (the
 * orchestration reads it once when either consuming section was requested);
 * a snapshot that is absent, never built, or unreadable degrades the
 * silent-coupling facts to the empty verdict and `wireSplitMerge` to its
 * absent reason — the run's silence contract — while the `incompleteChange`
 * section reports the unreadable case when it was asked for. An empty diff is
 * a VALID review: built, no findings.
 */

import {
  createCatFileBatch,
  findGitToplevel,
  gitPathFromRoot,
  gitPathPrefix,
  isAncestor,
  readEnclosingRepoGitState,
} from "../../../../adapters/vcs/index.js";
import type {
  FileDependencyEdge,
  FileDependencyGraphFile,
  FileExtraction,
  GlobalSymbolTable,
  RelPath,
  TemporalCochangeGraph,
} from "../../../../contracts/types/codegraph.js";
import {
  diffFindingEndpointRefs,
  type DiffDetectorFinding,
} from "../../../../contracts/types/diff-detector-finding.js";
import {
  applyEdgeOverlay,
  buildLayeringModel,
  readHubLikeDependency,
  readLayering,
  ReviewEdgeOverlay,
  type ComponentGraph,
  type ReviewFileEdgeRead,
} from "../../../../domains/trajectory/codegraph/symbols/index.js";
import {
  assessGraphCochangeSignificance,
  computeSplitMergeVerdicts,
  detectSilentCoupling,
  linkImportedCochangePairs,
  oneWalkedViolationImporters,
  type CochangeSignificance,
  type SilentCouplingReport,
} from "../../../../domains/trajectory/codegraph/temporal/index.js";
import type { ArchitectureChangeBlock, ReviewSectionNotJudgedEntry } from "../../../public/dto/review.js";
import {
  ArchitectureFactsCatalog,
  deriveArchitectureComponentFacts,
  measureLayeringFoundationAndTerminalComponents,
  measureLayeringFoundationFiles,
  measureMainSequenceDistances,
} from "../architecture-facts.js";
import { readArchitectureGraphFacts, type ArchitectureGraphFacts } from "../architecture-graph-facts.js";
import {
  architectureViolationCarrierFiles,
  ComponentEdgeCarrierIndex,
  FileMaintenanceCostModel,
  filesByComponent,
  maintenanceCostFamily,
  rankFamiliesByMaintenanceCost,
} from "../architecture-maintenance-cost.js";
import {
  ArchitectureReportOps,
  isDocumentationPath,
  readOnce,
  type ModuleImportSpecifierLookup,
} from "../architecture-report-ops.js";
import {
  collapsePersistingFindings,
  measureArchitectureViolationDelta,
  resolvedChangeSubjects,
  type ArchitectureViolationDelta,
} from "../architecture-violation-delta.js";
import {
  DiffDetectorRun,
  DiffFindingRemedyResolver,
  stampDiffFindingRemedies,
  type DiffDetectorBaseEdgeReader,
  type DiffDetectorContractReader,
  type DiffDetectorGraphReader,
  type DiffDetectorRunDeps,
  type DiffDetectorSilentCouplingFacts,
} from "../diff-detector-run.js";
import type { DiffScopeRead, DiffTreeLag } from "../diff-scope-reader.js";
import {
  extractReviewFile,
  extractReviewFileEdges,
  extractWorkingTreeFile,
  isWalkedReviewFile,
  resolveReviewFileEdges,
  workingTreeExtractionContext,
  type ReviewEdgeExtractionDeps,
  type ReviewEdgeReadContext,
  type ReviewSymbolTableRead,
} from "../review-edge-overlay.js";
import { buildReviewSymbolTable, type IndexedSymbolRows, type IndexedSymbolRowsRead } from "../review-symbol-table.js";
import {
  ArchitectureViolationTierLookup,
  composeReviewCochangeSignificance,
  separateTouchedActiveViolations,
  stampDiffFindingImpactTiers,
} from "./architecture-violation-impact-tiers.js";
import type {
  ReviewSectionBuildContext,
  ReviewSectionContext,
  ReviewSectionProvider,
} from "./review-section-provider.js";
import { WiredExportTableReader } from "./wired-export-table-reader.js";

/** Findings the section lists; the rest are counted in `truncated`. */
export const ARCHITECTURE_FINDING_CAP = 100;

/** One indexed edge as the detector ports serve it — direction and endpoints, nothing else. */
interface IndexedGraphEdge {
  readonly source: string;
  readonly target: string;
}

/**
 * `DiffDetectorGraphReader` over the indexed file edges: ONE bulk read (the
 * same `readFileDependencyGraph` the report opens), forward and reverse
 * adjacency built in memory — a diff holds ≤200 files and their neighborhoods
 * are small, so the reverse index is cheaper than a second query shape. Rows
 * are served VERBATIM from the production graph every report detector judges
 * (non-production exclusions applied, the same graph the extracted facts
 * derive from); a changed file's rows are NOT masked here — `DiffDetectorRun`
 * masks during traversal, per its docblock's masking contract.
 */
export class WiredGraphReader implements DiffDetectorGraphReader {
  private readonly outgoing: ReadonlyMap<string, readonly IndexedGraphEdge[]>;
  private readonly incoming: ReadonlyMap<string, readonly IndexedGraphEdge[]>;

  constructor(edges: readonly FileDependencyEdge[]) {
    const outgoing = new Map<string, IndexedGraphEdge[]>();
    const incoming = new Map<string, IndexedGraphEdge[]>();
    for (const edge of edges) {
      const row = { source: edge.sourceRelPath, target: edge.targetRelPath };
      pushTo(outgoing, edge.sourceRelPath, row);
      pushTo(incoming, edge.targetRelPath, row);
    }
    this.outgoing = outgoing;
    this.incoming = incoming;
  }

  edgesFrom(relPath: string): readonly IndexedGraphEdge[] {
    return this.outgoing.get(relPath) ?? EMPTY_EDGES;
  }

  edgesTo(relPath: string): readonly IndexedGraphEdge[] {
    return this.incoming.get(relPath) ?? EMPTY_EDGES;
  }
}

const EMPTY_EDGES: readonly IndexedGraphEdge[] = [];

/**
 * The production silent-coupling verdict for the diff-scoped family (bd
 * tea-rags-mcp-89k7k.1.10): run the whole-repo detector ONCE over the SAME
 * pre-read snapshot, the SAME production graph (walked census + file
 * dependency edges for the shared-neighbour index) and the SAME documentation
 * predicate the report uses — then hand the run its violation list and
 * exclusion counters verbatim. Re-judging raw partner rows in the diff path
 * (the pre-fix behaviour) skipped the strength cut and the shared-neighbour
 * explanation and let 19–98 historical src~test / CLAUDE.md~code pairs per
 * diff drown the findings; consuming the verdict makes drift structurally
 * impossible. No build / unreadable snapshot degrades to an empty graph
 * (built:false summary, no violations) — silence, never a zero verdict.
 *
 * The report's second `linkImportedCochangePairs` pass (asset-import
 * specifiers, bd tea-rags-mcp-rbnkp) is replicated SCOPED to the pairs the
 * review can report (bd tea-rags-mcp-2wsnt): the run judges pairs touching
 * `changedFiles` only, so one-walked violations off the diff cost no read.
 * Diff-touching one-walked pairs get their walked endpoint's specifiers read
 * — `readImportSpecifiers`, the SAME payload read the report wires
 * (`readPayloadImportSpecifiers`) — the snapshot is relinked and the detector
 * re-run, so a linked pair drops out of the facts exactly as the report's
 * second pass drops it. A stale payload (the specifier recorded at index
 * time, not read from the tree) is the report's own semantics, kept here for
 * parity. No wired read (unit wiring), no snapshot, or no diff-touching
 * one-walked pair leaves the single-pass verdict.
 */
export async function buildSilentCouplingFacts(
  snapshot: TemporalCochangeGraph | null | undefined,
  productionFiles: readonly FileDependencyGraphFile[],
  productionEdges: readonly FileDependencyEdge[],
  changedFiles: readonly string[],
  readImportSpecifiers?: ModuleImportSpecifierLookup,
  diffCommits?: readonly string[],
  significance = assessReviewQueryCochangeSignificance(snapshot, changedFiles, diffCommits),
): Promise<DiffDetectorSilentCouplingFacts> {
  const graph = snapshot ?? EMPTY_COCHANGE;
  const options = {
    isDocumentation: isDocumentationPath,
    fileDependencyEdges: productionEdges,
    ...(significance ? { significance } : {}),
  };
  const first = detectSilentCoupling(graph, productionFiles, options);
  if (readImportSpecifiers === undefined || snapshot === null || snapshot === undefined) {
    return silentCouplingFactsOf(first);
  }
  const changed = new Set(changedFiles);
  const diffTouching = first.violations.filter((v) => changed.has(v.relPathA) || changed.has(v.relPathB));
  const importers = oneWalkedViolationImporters(diffTouching, productionFiles);
  if (importers.length === 0) return silentCouplingFactsOf(first);
  const linked = linkImportedCochangePairs(graph, await readImportSpecifiers(importers));
  return silentCouplingFactsOf(detectSilentCoupling(linked, productionFiles, options));
}

/**
 * The review's co-change gate over the pairs the diff touches (bd
 * tea-rags-mcp-89k7k.1.14): the query family — every pair touching the diff,
 * judged against the history minus the diff's own commits. Undefined when
 * the snapshot carries no bundle history.
 */
export function assessReviewQueryCochangeSignificance(
  snapshot: TemporalCochangeGraph | null | undefined,
  changedFiles: readonly string[],
  diffCommits?: readonly string[],
): CochangeSignificance | undefined {
  return assessGraphCochangeSignificance(snapshot ?? EMPTY_COCHANGE, {
    kind: "query",
    diffFiles: changedFiles,
    ...(diffCommits ? { diffCommits } : {}),
  });
}

/** The report's violation list and exclusion counters, mapped to the port shape. */
function silentCouplingFactsOf(report: SilentCouplingReport): DiffDetectorSilentCouplingFacts {
  return {
    violations: report.violations.map((v) => ({
      relPathA: v.relPathA,
      relPathB: v.relPathB,
      support: v.support,
      strength: v.strength,
      ...(v.expectedSupport === undefined ? {} : { expectedSupport: v.expectedSupport }),
    })),
    excluded: report.summary.excluded,
    ...(report.summary.cochangeSignificance ? { cochangeSignificance: report.summary.cochangeSignificance } : {}),
  };
}

/**
 * `DiffDetectorContractReader` over the report's component partition and the
 * SAME production graph the other ports read (bd tea-rags-mcp-89k7k.1.6):
 * `facadeComponentOf` answers only for a MEASURED module's entry file;
 * `indexedConsumersOf` serves the indexed demand on that facade — distinct
 * sources outside the facade's own component, the names their imports
 * recorded, absent when none did ("not recorded" is never "names nothing");
 * `indexedSurfaceOf` serves the facade's own persisted re-export names, the
 * pre-diff surface a dropped name must have left.
 */
export class WiredContractReader implements DiffDetectorContractReader {
  private readonly componentByFacade: ReadonlyMap<string, string>;
  private readonly consumersByFacade: ReadonlyMap<string, readonly { source: string; importedNames?: string[] }[]>;
  private readonly surfaceByFacade: ReadonlyMap<string, readonly string[]>;

  constructor(components: ComponentGraph, edges: readonly FileDependencyEdge[]) {
    this.componentByFacade = new Map(
      [...components.components].flatMap(([componentDir, component]) =>
        component.facadeRelPath === null ? [] : [[component.facadeRelPath, componentDir] as const],
      ),
    );
    const consumersByFacade = new Map<string, { source: string; importedNames?: string[] }[]>();
    const surfaceByFacade = new Map<string, Set<string>>();
    const served = new Set<string>();
    for (const edge of edges) {
      if (edge.reexportedExportNames !== undefined && this.componentByFacade.has(edge.sourceRelPath)) {
        const surface = surfaceByFacade.get(edge.sourceRelPath) ?? new Set<string>();
        for (const name of edge.reexportedExportNames) surface.add(name);
        surfaceByFacade.set(edge.sourceRelPath, surface);
      }
      const componentDir = this.componentByFacade.get(edge.targetRelPath);
      if (componentDir === undefined) continue;
      // A source inside the facade's own component is the module's own file —
      // the contract judges consumers the module SURVES, not its internals.
      if (components.componentOf.get(edge.sourceRelPath) === componentDir) continue;
      // Distinct by source: the persisted graph holds one row per (source,
      // target) with that row's names already unioned over its statements, so
      // the first row per source IS that source's recorded demand.
      if (!served.add(`${edge.targetRelPath}\u0000${edge.sourceRelPath}`)) continue;
      pushTo(consumersByFacade, edge.targetRelPath, {
        source: edge.sourceRelPath,
        ...(edge.importedExportNames !== undefined ? { importedNames: [...edge.importedExportNames] } : {}),
      });
    }
    this.consumersByFacade = consumersByFacade;
    this.surfaceByFacade = new Map([...surfaceByFacade].map(([facade, names]) => [facade, [...names]]));
  }

  facadeComponentOf(relPath: string): string | undefined {
    return this.componentByFacade.get(relPath);
  }

  indexedConsumersOf(facade: string): readonly { source: string; importedNames?: string[] }[] {
    return this.consumersByFacade.get(facade) ?? EMPTY_CONSUMERS;
  }

  indexedSurfaceOf(facade: string): readonly string[] | undefined {
    return this.surfaceByFacade.get(facade);
  }
}

const EMPTY_CONSUMERS: readonly { source: string; importedNames?: string[] }[] = [];

/**
 * The split/merge port over the pre-read co-change snapshot (bd
 * tea-rags-mcp-c3v6o): the phase-1 verdicts drawn over the SAME component
 * partition the other ports read, exactly as the whole-repo report's
 * `summariseSplitMerge` draws them. Absent substrate yields the absent reason
 * instead of a port — the report's own vocabulary (`noCochangeBuild`,
 * `noBundleMembership`) plus `cochangeUnreadable` when the read failed — so
 * the family answers built:false, never a zero verdict.
 */
export function wireSplitMerge(
  snapshot: TemporalCochangeGraph | null | undefined,
  readError: string | undefined,
  components: ComponentGraph,
): Pick<DiffDetectorRunDeps, "splitMerge" | "splitMergeAbsentReason"> {
  if (readError !== undefined) return { splitMergeAbsentReason: "cochangeUnreadable" };
  if (!snapshot?.meta) return { splitMergeAbsentReason: "noCochangeBuild" };
  if (!snapshot.bundles || snapshot.bundles.size === 0) return { splitMergeAbsentReason: "noBundleMembership" };
  const { componentOf } = components;
  return {
    splitMerge: {
      verdicts: computeSplitMergeVerdicts({
        components: { componentOf },
        edges: snapshot.edges,
        bundles: snapshot.bundles,
      }),
      componentOf: (relPath) => componentOf.get(relPath),
    },
  };
}

/**
 * The diff base's edges of the scope files (bd tea-rags-mcp-89k7k.1.16): each
 * file's blob AT THE MERGE-BASE, walked by the same extraction the tree read
 * uses ({@link extractReviewFileEdges}). Cost is bounded by the diff — one
 * `cat-file --batch` process, one blob and one walk per scope file, never a
 * repository-wide read.
 *
 * A path the merge-base does not hold reads as an empty blob — a file the diff
 * created imported nothing before it, so every edge it holds is diff-added. A
 * file whose base blob does not extract (unsupported language, failed walk)
 * answers `undefined` and the indexed graph decides its edges, as before.
 * Undefined as a whole — the index decides everywhere — when the merge-base
 * is not a commit the tree's HEAD descends from (no repository, an unknown
 * sha): an unreadable base is never "nothing existed before".
 *
 * A file the change MOVED is read at the path the merge-base held it
 * (`renamedFrom`, bd tea-rags-mcp-slsia) — the move's own references are not
 * added by the move. With `rename`, a tree edge the base read lacks to a
 * touched target gets a second read: see {@link holdRenamedTargets}.
 */
export async function readDiffBaseEdges(
  scope: Pick<DiffScopeRead, "workTree" | "mergeBase" | "files" | "touchedFiles" | "renamedFrom">,
  extraction: ReviewEdgeExtractionDeps,
  context: ReviewEdgeReadContext,
  rename?: DiffBaseRenameReading,
): Promise<DiffDetectorBaseEdgeReader | undefined> {
  const toplevel = findGitToplevel(scope.workTree);
  if (toplevel === undefined || scope.files.length === 0) return undefined;
  // A merge-base at HEAD is its own ancestor — answered from the repository's
  // files, not a git child (bd tea-rags-mcp-0qaht.63).
  const atHead = readEnclosingRepoGitState(toplevel)?.commit === scope.mergeBase;
  if (!atHead && !(await isAncestor(toplevel, scope.mergeBase, "HEAD"))) return undefined;
  const prefix = gitPathPrefix(toplevel, scope.workTree);
  const targetsBySource = new Map<string, Set<string>>();
  const baseTexts = new Map<string, { basePath: string; text: string }>();
  const blobs = createCatFileBatch(toplevel);
  const readBaseBlob = async (basePath: string): Promise<string> =>
    blobs.read(scope.mergeBase, gitPathFromRoot(basePath, prefix));
  try {
    for (const relPath of scope.files) {
      const basePath = scope.renamedFrom?.get(relPath) ?? relPath;
      const text = await readBaseBlob(basePath);
      const read = extractReviewFileEdges(extraction, scope.workTree, basePath, text, context);
      if (read.skip !== undefined) continue;
      targetsBySource.set(relPath, new Set(read.edges.map((edge) => edge.targetRelPath)));
      baseTexts.set(relPath, { basePath, text });
    }
    if (rename !== undefined) {
      await holdRenamedTargets({ scope, extraction, context, rename, targetsBySource, baseTexts, readBaseBlob });
    }
  } finally {
    await blobs.close();
  }
  return { targetsAtBase: (relPath) => targetsBySource.get(relPath) };
}

/**
 * What the base read needs to see a rename's base side (bd tea-rags-mcp-slsia):
 * the tree's targets of a scope file, and the review's table rebuilt with some
 * touched files carrying their BASE definitions.
 */
export interface DiffBaseRenameReading {
  /** The tree read's targets of one scope file; `undefined` = its read was skipped. */
  treeTargetsOf: (relPath: string) => ReadonlySet<string> | undefined;
  /** The review's table, these extractions' definitions replacing their files' tree definitions. */
  tableWithBaseDefinitions: (baseExtractions: readonly FileExtraction[]) => GlobalSymbolTable;
}

/**
 * The base side of a rename (bd tea-rags-mcp-slsia). Both sides resolve against
 * the TREE's table, so a base text naming a constant the change renamed — taxdome
 * `include Platform::Concerns::AuthMethods` → `include Platform::AuthMethods`,
 * same file — resolves nowhere and the tree's edge to that file read as added.
 * For every tree edge the first read lacks whose target the change touched,
 * the target's BASE blob (at its pre-move path) is walked, and the source's base
 * text is resolved again against the table with those base definitions: a
 * target it now reaches is held before the change. A target the base text never
 * named stays added — the second read only adds the base world's definitions of
 * touched files, never a looser match. Untouched targets are skipped: their
 * definitions are the same on both sides.
 */
async function holdRenamedTargets(baseRead: {
  scope: Pick<DiffScopeRead, "workTree" | "touchedFiles" | "renamedFrom">;
  extraction: ReviewEdgeExtractionDeps;
  context: ReviewEdgeReadContext;
  rename: DiffBaseRenameReading;
  targetsBySource: Map<string, Set<string>>;
  baseTexts: ReadonlyMap<string, { basePath: string; text: string }>;
  readBaseBlob: (basePath: string) => Promise<string>;
}): Promise<void> {
  const { scope, extraction, context, rename, targetsBySource } = baseRead;
  const unheldBySource = new Map<string, string[]>();
  for (const [relPath, atBase] of targetsBySource) {
    const unheld = [...(rename.treeTargetsOf(relPath) ?? [])].filter(
      (target) => !atBase.has(target) && scope.touchedFiles.has(target),
    );
    if (unheld.length > 0) unheldBySource.set(relPath, unheld);
  }
  const baseExtractions: FileExtraction[] = [];
  for (const target of new Set([...unheldBySource.values()].flat())) {
    const text = await baseRead.readBaseBlob(scope.renamedFrom?.get(target) ?? target);
    if (text === "") continue;
    const walked = extractReviewFile(extraction, target, text, context);
    if (isWalkedReviewFile(walked)) baseExtractions.push(walked);
  }
  if (baseExtractions.length === 0) return;
  const baseWorld: ReviewEdgeReadContext = {
    ...context,
    symbolTable: { table: rename.tableWithBaseDefinitions(baseExtractions) },
  };
  for (const [relPath, unheld] of unheldBySource) {
    const sourceAtBase = baseRead.baseTexts.get(relPath);
    if (sourceAtBase === undefined) continue;
    const reread = extractReviewFileEdges(
      extraction,
      scope.workTree,
      sourceAtBase.basePath,
      sourceAtBase.text,
      baseWorld,
    );
    const reached = new Set(reread.edges.map((edge) => edge.targetRelPath));
    for (const target of unheld) if (reached.has(target)) targetsBySource.get(relPath)?.add(target);
  }
}

/**
 * The change's edges on both sides, read once per section run: the working
 * tree's reads of every scope file (one shared extraction context; a file that
 * cannot be read or resolved lands in the overlay's unsupported reads —
 * notJudged, never edge-free) as the overlay, and the diff base's edges of the
 * SAME files ({@link readDiffBaseEdges}, bd tea-rags-mcp-89k7k.1.16) — what
 * "added by this change" is measured against, wherever the index sits.
 *
 * Both sides resolve against ONE symbol table (bd tea-rags-mcp-vdhjc): the
 * index's rows overlaid with the tree — every scope file is walked first so
 * its definitions replace the index's, then each is resolved. Unavailable rows
 * leave the table-reading languages skipped with the cause. The base side's
 * second read (bd tea-rags-mcp-slsia) rebuilds the same table with touched
 * targets' BASE definitions — only when rows were read.
 */
export async function readReviewChangeEdges(
  scope: Pick<DiffScopeRead, "workTree" | "mergeBase" | "files" | "touchedFiles" | "renamedFrom">,
  deps: ReviewEdgeExtractionDeps,
  indexedSymbols: IndexedSymbolRowsRead = { unavailable: "no indexed symbol table was read for this review" },
): Promise<{ overlay: ReviewEdgeOverlay; baseEdges: DiffDetectorBaseEdgeReader | undefined }> {
  const extractionContext = workingTreeExtractionContext(scope.workTree, deps.languageFactory);
  const walked = scope.files.map((relPath) => extractWorkingTreeFile(deps, scope.workTree, relPath, extractionContext));
  const treeExtractions = walked.filter(isWalkedReviewFile);
  const tableOver = (rows: IndexedSymbolRows, baseExtractions?: readonly FileExtraction[]): GlobalSymbolTable =>
    buildReviewSymbolTable(rows, {
      workTree: scope.workTree,
      touchedFiles: scope.touchedFiles,
      treeExtractions,
      ...(baseExtractions !== undefined ? { baseExtractions } : {}),
    });
  const symbolTable: ReviewSymbolTableRead =
    "rows" in indexedSymbols ? { table: tableOver(indexedSymbols.rows) } : { unavailable: indexedSymbols.unavailable };
  const context: ReviewEdgeReadContext = { ...extractionContext, symbolTable };
  const reads: ReviewFileEdgeRead[] = walked.map((read) =>
    isWalkedReviewFile(read) ? resolveReviewFileEdges(deps, scope.workTree, read, context) : read,
  );
  const treeTargets = new Map(
    reads
      .filter((read) => read.skip === undefined)
      .map((read) => [read.relPath, new Set(read.edges.map((edge) => edge.targetRelPath))] as const),
  );
  const rename: DiffBaseRenameReading | undefined =
    "rows" in indexedSymbols
      ? {
          treeTargetsOf: (relPath) => treeTargets.get(relPath),
          tableWithBaseDefinitions: (baseExtractions) => tableOver(indexedSymbols.rows, baseExtractions),
        }
      : undefined;
  const baseEdges = await readDiffBaseEdges(scope, deps, context, rename);
  return { overlay: new ReviewEdgeOverlay(reads), baseEdges };
}

/** A co-change graph with no build — what an absent or unreadable snapshot judges as. */
const EMPTY_COCHANGE: TemporalCochangeGraph = { meta: null, edges: [] };

/**
 * The full detector set over the index's facts and over the same facts with
 * the tree's edges overlaid (bd tea-rags-mcp-89k7k.1.7), compared by key.
 * Both runs are UNCAPPED — the report's per-family `limit` would cut
 * violations from one side and fabricate introduced / resolved — and share
 * one set of history lookups, so only the edges differ between them. The
 * families an edge overlay cannot move (silent coupling and shotgun surgery
 * read git history; norms are not requested) answer alike on both sides.
 * The asset-import specifier read is left out: it relinks silent-coupling
 * pairs identically on both sides, so it cannot move a key, and it would
 * read every one-walked pair of the repository instead of the diff's.
 *
 * Impact tiers (bd tea-rags-mcp-r8hme.53 T2): both runs tag their violations
 * against ONE co-change gate — `querySignificance` (the pass silent coupling
 * already read) for the pairs the diff touches, so the diff's own commits
 * cannot make a carrying pair active, and one full pass for every other pair
 * (`composeReviewCochangeSignificance`). Two passes per review, not one per
 * judge. No query gate (no bundle history) leaves each judge to its own full
 * pass, which then finds no history either and claims no tier.
 */
export async function measureChangeViolationDelta(
  facts: ArchitectureGraphFacts,
  overlay: ReviewEdgeOverlay,
  lookups: Pick<ReviewSectionContext, "scope" | "readFileMaintenanceSignals">,
  querySignificance?: CochangeSignificance,
): Promise<{ delta: ArchitectureViolationDelta; tiers: ArchitectureViolationTierLookup }> {
  const ops = new ArchitectureReportOps();
  const request = { limit: Number.POSITIVE_INFINITY };
  const fullSignificance = querySignificance && assessGraphCochangeSignificance(facts.cochange, { kind: "full" });
  const history = {
    readFileMaintenanceSignals: lookups.readFileMaintenanceSignals,
    ...(querySignificance && fullSignificance
      ? {
          cochangeSignificance: composeReviewCochangeSignificance(
            fullSignificance,
            querySignificance,
            lookups.scope.files,
          ),
        }
      : {}),
  };
  const [base, overlaid] = await Promise.all([
    ops.judge(facts, request, history),
    ops.judge(applyEdgeOverlay(facts, overlay), request, history),
  ]);
  const delta = measureArchitectureViolationDelta(base.violations, overlaid.violations, lookups.scope.renamedFrom);
  return { delta, tiers: new ArchitectureViolationTierLookup(base.violations, delta) };
}

/**
 * The change block's lag fields. The comparison's base is the INDEX, not the
 * merge-base: when the index lacks commits the merge-base holds, a scope
 * file's edits from those commits sit in the overlay but not in the base, so
 * "introduced" may hold changes already committed — flagged, never withheld
 * (owner decision 2026-10-11). An index that contains the merge-base (it is
 * the merge-base or descends from it) cannot put base commits in introduced.
 * No repository, or an indexed commit the repository does not know, cannot
 * be cleared.
 */
export async function readIndexLagVerdict(
  scope: Pick<DiffScopeRead, "workTree" | "mergeBase">,
  indexLag: DiffTreeLag | undefined,
): Promise<Pick<ArchitectureChangeBlock, "indexLag" | "maybeAlreadyCommitted">> {
  if (indexLag === undefined) return {};
  if (indexLag.indexedCommit === scope.mergeBase) return { indexLag };
  const toplevel = findGitToplevel(scope.workTree);
  const indexHoldsMergeBase =
    toplevel !== undefined && (await isAncestor(toplevel, scope.mergeBase, indexLag.indexedCommit));
  return indexHoldsMergeBase ? { indexLag } : { indexLag, maybeAlreadyCommitted: true };
}

export const architectureSectionProvider: ReviewSectionProvider = {
  id: "architecture",
  consumesTemporalCochange: true,

  isBuilt: (context) => {
    if (context.graphDb === undefined) {
      return { built: false, reason: "codegraph database unavailable for the addressed collection" };
    }
    if (context.reviewEdgeExtraction === undefined) {
      return { built: false, reason: "review edge extraction not wired (codegraph disabled)" };
    }
    return { built: true };
  },

  run: async (context) => {
    const { graphDb, reviewEdgeExtraction, scope } = context;
    if (graphDb === undefined || reviewEdgeExtraction === undefined) {
      return { built: false, reason: "architecture substrate vanished between isBuilt and run" };
    }

    // The indexed side, read once: the whole report's graph facts (the
    // production graph rows the traversal serves, the member edges and the
    // co-change snapshot the full detector set judges, bd
    // tea-rags-mcp-89k7k.1.7) and the report-derived facts the catalogue
    // answers from. The pre-read snapshot is reused, never read again.
    const graphFacts = await readArchitectureGraphFacts(
      graphDb,
      { cochange: context.temporalCochange ?? EMPTY_COCHANGE },
      context.readIndexedFileImports,
      context.readDeclaredTestDependencies,
    );
    const { production } = graphFacts;
    const readFileMaintenanceSignals =
      context.readFileMaintenanceSignals === undefined ? undefined : readOnce(context.readFileMaintenanceSignals);
    const facts = deriveArchitectureComponentFacts(production.graph, undefined, undefined, production.nonProduction);
    const mainSequence = measureMainSequenceDistances(facts.components, production.graph.files);
    // One layering model over the catalog's partition: the foundation the
    // catalog names and the levels the layeringBackEdge family judges.
    const layeringModel = buildLayeringModel(facts.components);
    // One foundation measurement: the catalog's foundation files and the
    // components the hub reading leaves out of Ce (bd tea-rags-mcp-g77p3).
    const foundationComponents = measureLayeringFoundationAndTerminalComponents(production.graph, facts, layeringModel);
    const catalog = new ArchitectureFactsCatalog(
      facts,
      mainSequence.distanceByComponent,
      measureLayeringFoundationFiles(production.graph, facts, layeringModel, foundationComponents),
    );
    const graph = new WiredGraphReader(production.graph.edges);
    const contract = new WiredContractReader(facts.components, production.graph.edges);
    const splitMerge = wireSplitMerge(context.temporalCochange, context.temporalCochangeError, facts.components);
    // The production silent-coupling verdict over the SAME snapshot (bd
    // tea-rags-mcp-89k7k.1.10) — the run consumes it, never re-judges raw
    // pairs. The asset-import rescue reads the context's payload
    // specifiers for the diff-touching one-walked pairs only (bd
    // tea-rags-mcp-2wsnt). Its query gate is read once and reused by the
    // impact tiers of the change delta (bd tea-rags-mcp-r8hme.53).
    const querySignificance = assessReviewQueryCochangeSignificance(
      context.temporalCochange,
      scope.files,
      scope.diffCommits,
    );
    const silentCouplingFacts = await buildSilentCouplingFacts(
      context.temporalCochange,
      production.graph.files,
      production.graph.edges,
      scope.files,
      context.readImportSpecifiers,
      scope.diffCommits,
      querySignificance,
    );

    const { overlay, baseEdges } = await readReviewChangeEdges(
      scope,
      reviewEdgeExtraction,
      await context.readIndexedSymbolRows?.(),
    );
    const run = new DiffDetectorRun({
      graph,
      ...(baseEdges !== undefined ? { baseEdges } : {}),
      catalog,
      silentCouplingFacts,
      contract,
      ...splitMerge,
      mainSequenceDistanceThreshold: mainSequence.distanceThreshold,
      layering: readLayering(facts.components, layeringModel),
      hubLike: readHubLikeDependency(facts.components, { foundationComponents }),
    });
    const runScope = {
      changedFiles: scope.files,
      // Presence is the whole change, the cap limits only the sources (bd
      // tea-rags-mcp-lxbrr).
      touchedFiles: scope.touchedFiles,
      // A truncated scope marks every built family partial (bd
      // tea-rags-mcp-89k7k.1.9): the cap's skipped files never reach the
      // overlay, so a family's zero can rest on edges it never saw.
      ...(scope.skipped > 0 ? { skippedFiles: scope.skipped } : {}),
    };
    // Each finding carries its dry-run-verified repair (bd
    // tea-rags-mcp-89k7k.1.19.6), stamped before ranking and the cap; the
    // what-if re-runs the SAME run over the edited overlay.
    const result = stampDiffFindingRemedies(
      run.run(runScope, overlay),
      new DiffFindingRemedyResolver({
        overlay,
        exports: new WiredExportTableReader(contract, production.graph.edges),
        rejudge: (edits) => run.rejudge(runScope, overlay, edits),
      }),
    );
    // What the change does to the whole repository's violations (bd
    // tea-rags-mcp-89k7k.1.7): findings keep what it introduced plus any
    // finding a remedy repairs cheaply; the rest collapse into the compact
    // change block. Collapsed AFTER the remedies are stamped (a remedy keeps
    // its finding) and BEFORE ranking and the cap.
    // Each finding carries its report violation's impact tier, stamped
    // before the collapse so the compact persisting entries keep it (bd
    // tea-rags-mcp-r8hme.53); a touched active/critical one is lifted out of
    // `persisting` into `touchedActive`.
    const { delta, tiers } = await measureChangeViolationDelta(
      graphFacts,
      overlay,
      { ...context, readFileMaintenanceSignals },
      querySignificance,
    );
    const tieredFindings = stampDiffFindingImpactTiers(result.findings, tiers, scope.renamedFrom);
    const collapsed = collapsePersistingFindings(tieredFindings, delta, scope.renamedFrom);
    const carriers = new ComponentEdgeCarrierIndex(facts.components.componentOf, facts.components.dependencies);
    const touched = separateTouchedActiveViolations({
      persisting: collapsed.persisting,
      findings: tieredFindings,
      tiers,
      changedFiles: scope.files,
      carrierFilesOf: (violation) => architectureViolationCarrierFiles(violation, carriers),
      ...(scope.renamedFrom ? { renamedFrom: scope.renamedFrom } : {}),
    });
    // Ranked by maintenance cost BEFORE the cap (bd tea-rags-mcp-r8hme.20),
    // so a family's slots keep its costliest findings.
    const findings = await rankDiffFindingsByMaintenanceCost(
      collapsed.kept,
      readFileMaintenanceSignals,
      facts.components.componentOf,
    );
    const { kept, truncatedByDetector } = capFindingsByFamily(findings, ARCHITECTURE_FINDING_CAP);
    const notJudged: ReviewSectionNotJudgedEntry[] = overlay.unsupported().map((skip) => ({
      relPath: skip.relPath,
      reason: skip.reason,
      ...(skip.detail !== undefined ? { detail: skip.detail } : {}),
    }));
    return {
      findings: kept,
      detectors: result.detectors.map((status) => {
        const truncated = truncatedByDetector.get(status.detector);
        const persistingCount = collapsed.persistingByDetector.get(status.detector);
        return {
          ...status,
          ...(truncated === undefined ? {} : { truncated }),
          ...(persistingCount === undefined ? {} : { persistingCount }),
        };
      }),
      ...(findings.length > kept.length ? { truncated: findings.length - kept.length } : {}),
      ...(notJudged.length > 0 ? { notJudged } : {}),
      change: {
        introducedCount: collapsed.introducedCount,
        nonLocal: collapsed.nonLocal,
        resolved: resolvedChangeSubjects(delta),
        persisting: touched.persisting,
        touchedActive: touched.touchedActive,
        ...(await readIndexLagVerdict(scope, context.indexLag)),
      } satisfies ArchitectureChangeBlock,
    };
  },
};

/**
 * The findings cap's family-aware policy (bd tea-rags-mcp-35v4v): the plain
 * `slice(0, cap)` over the run's concatenated findings let one loud family —
 * 117 silentCoupling pairs on a live 5-file probe diff — push every later
 * family (facadeContract 1, splitCandidates 2, the most diff-native ones)
 * entirely into `truncated`, while their detector rows still counted them.
 *
 * Allocation, stated once:
 * 1. FLOOR — every family with ≥1 finding is guaranteed one slot; a family is
 *    never fully starved, whatever the others' volume (families ≤ 8, cap 100,
 *    so the floor always fits; were it ever exceeded, earlier family order
 *    keeps its slots first).
 * 2. PROPORTIONAL FILL — the remaining budget is split over each family's
 *    UNMET findings (count − floor) by largest remainder. Sharing the deficit,
 *    not the raw count, means no share can exceed what a family still lacks —
 *    no clamping pass. Remainder ties break by the run's family order.
 * 3. HONESTY — the total never exceeds `cap`; every cut is counted per family
 *    on the detector row (`truncated`), so `findingCount` minus the family's
 *    listed findings always reconciles. Kept findings stay in family order,
 *    each family's own findings in the run's emission order.
 */
export function capFindingsByFamily(
  findings: readonly DiffDetectorFinding[],
  cap: number,
): { kept: DiffDetectorFinding[]; truncatedByDetector: ReadonlyMap<string, number> } {
  if (findings.length <= cap) return { kept: [...findings], truncatedByDetector: new Map() };
  const order: string[] = [];
  const byDetector = new Map<string, DiffDetectorFinding[]>();
  for (const finding of findings) {
    const family = byDetector.get(finding.detector);
    if (family === undefined) {
      byDetector.set(finding.detector, [finding]);
      order.push(finding.detector);
    } else family.push(finding);
  }

  const allocation = new Map<string, number>();
  let budget = cap;
  for (const detector of order) {
    if (budget <= 0) break;
    allocation.set(detector, 1); // the floor: never fully starved
    budget--;
  }
  const deficitOf = (detector: string): number =>
    (byDetector.get(detector)?.length ?? 0) - (allocation.get(detector) ?? 0);
  const unmetTotal = order.reduce((sum, detector) => sum + deficitOf(detector), 0);
  if (budget > 0 && unmetTotal > 0) {
    const shares = order.map((detector, index) => ({
      index,
      detector,
      deficit: deficitOf(detector),
      ideal: (budget * deficitOf(detector)) / unmetTotal,
    }));
    for (const share of shares) {
      allocation.set(share.detector, (allocation.get(share.detector) ?? 0) + Math.floor(share.ideal));
    }
    let leftover = budget - shares.reduce((sum, share) => sum + Math.floor(share.ideal), 0);
    // Largest remainder first; ties keep the run's family order.
    const byRemainder = shares
      .map((share) => ({ index: share.index, remainder: share.ideal - Math.floor(share.ideal) }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const { index } of byRemainder) {
      if (leftover <= 0) break;
      if (shares[index].deficit <= Math.floor(shares[index].ideal)) continue; // already served its whole deficit
      allocation.set(shares[index].detector, (allocation.get(shares[index].detector) ?? 0) + 1);
      leftover--;
    }
  }

  const kept: DiffDetectorFinding[] = [];
  const truncatedByDetector = new Map<string, number>();
  for (const detector of order) {
    const family = byDetector.get(detector) ?? [];
    const slots = allocation.get(detector) ?? 0;
    kept.push(...family.slice(0, slots));
    if (family.length > slots) truncatedByDetector.set(detector, family.length - slots);
  }
  return { kept, truncatedByDetector };
}

/**
 * The run's findings with each family ranked by maintenance cost (bd
 * tea-rags-mcp-r8hme.20) — the whole-repo report's scorer and ranker, with
 * THIS review's findings as the population the shrinkage is estimated over
 * (bd tea-rags-mcp-afyku): the same carriers read the same `meanPosition` in
 * both answers, but the score is relative to the findings ranked beside it:
 * their spread is measured around the null mean 0.5 (the centre the score
 * shrinks toward), so even a lone finding is scored by the same rule. Families keep the run's
 * order (the cap allocates by family); inside one, costliest first, untagged
 * last. No
 * wired read, or nothing to rank, returns the findings as the run listed them
 * and reads nothing.
 */
export async function rankDiffFindingsByMaintenanceCost(
  findings: readonly DiffDetectorFinding[],
  readFileMaintenanceSignals: ReviewSectionBuildContext["readFileMaintenanceSignals"],
  componentOf: ReadonlyMap<RelPath, string>,
): Promise<readonly DiffDetectorFinding[]> {
  if (readFileMaintenanceSignals === undefined || findings.length === 0) return findings;
  const model = new FileMaintenanceCostModel(await readFileMaintenanceSignals());
  const filesOfComponent = filesByComponent(componentOf);
  const byDetector = new Map<string, DiffDetectorFinding[]>();
  for (const finding of findings) pushTo(byDetector, finding.detector, finding);
  const carriersOf = (finding: DiffDetectorFinding) => diffFindingCarrierFiles(finding, filesOfComponent);
  return rankFamiliesByMaintenanceCost(
    [...byDetector.values()].map((family) => maintenanceCostFamily(family, carriersOf)),
    model,
  ).flat();
}

/**
 * The files a diff finding names, read off its structured endpoints (bd
 * tea-rags-mcp-r8hme.44): a grouped silent-coupling finding's shared endpoint
 * and partners; otherwise the endpoint files, and each endpoint component
 * standing for its files under the report's partition — a component the
 * partition does not hold keeps its name, as before the endpoints were typed.
 */
function diffFindingCarrierFiles(
  finding: DiffDetectorFinding,
  filesOfComponent: (component: string) => readonly RelPath[],
): RelPath[] {
  const refs = diffFindingEndpointRefs(finding.endpoints);
  const files = [...refs.files, ...(finding.partners ?? []).map((partner) => partner.relPath)];
  const componentFiles = refs.components.flatMap((component) => {
    const members = filesOfComponent(component);
    return members.length > 0 ? members : [component];
  });
  return [...new Set([...files, ...componentFiles])];
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
