/**
 * The `architecture` review section (bd tea-rags-mcp-89k7k.1.4, F3 slice 2):
 * the wiring of F2's `DiffDetectorRun` to the REAL substrate — the indexed
 * graph and the whole-repo report's extracted facts (`architecture-facts.ts`)
 * on one side, F1's working-tree edges (`readReviewFileEdges` →
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

import { randomInt } from "node:crypto";

import { REVIEW_EDGE_MAX_AGE_SECONDS } from "../../../../adapters/duckdb/review-edge-store.js";
import type {
  FileDependencyEdge,
  FileDependencyGraphFile,
  TemporalCochangeGraph,
} from "../../../../contracts/types/codegraph.js";
import type { ComponentGraph } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import {
  computeSplitMergeVerdicts,
  detectSilentCoupling,
} from "../../../../domains/trajectory/codegraph/temporal/index.js";
import type { ReviewSectionNotJudgedEntry } from "../../../public/dto/review.js";
import {
  ArchitectureFactsCatalog,
  deriveArchitectureComponentFacts,
  distanceFromMainSequenceByComponent,
  readProductionArchitectureGraph,
} from "../architecture-facts.js";
import { isDocumentationPath } from "../architecture-report-ops.js";
import {
  DiffDetectorRun,
  type DiffDetectorContractReader,
  type DiffDetectorFinding,
  type DiffDetectorGraphReader,
  type DiffDetectorRunDeps,
  type DiffDetectorSilentCouplingFacts,
} from "../diff-detector-run.js";
import {
  readReviewFileEdges,
  ReviewEdgeOverlay,
  workingTreeExtractionContext,
  type ReviewFileEdgeRead,
} from "../review-edge-overlay.js";
import type { ReviewSectionProvider } from "./review-section-provider.js";

/** Findings the section lists; the rest are counted in `truncated`. */
export const ARCHITECTURE_FINDING_CAP = 100;

/** The minted id's random tail: lowercase alnum, the store's pattern exactly. */
const REVIEW_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

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
 * (built:false summary, no violations) — silence, never a zero verdict. The
 * report's second `linkImportedCochangePairs` pass (asset-import specifiers)
 * is not replicated: it needs working-tree specifier reads the review does
 * not do; the snapshot's own linkage union covers every resolved import.
 */
export function buildSilentCouplingFacts(
  snapshot: TemporalCochangeGraph | null | undefined,
  productionFiles: readonly FileDependencyGraphFile[],
  productionEdges: readonly FileDependencyEdge[],
): DiffDetectorSilentCouplingFacts {
  const report = detectSilentCoupling(snapshot ?? { meta: null, edges: [] }, productionFiles, {
    isDocumentation: isDocumentationPath,
    fileDependencyEdges: productionEdges,
  });
  return {
    violations: report.violations.map((v) => ({
      relPathA: v.relPathA,
      relPathB: v.relPathB,
      support: v.support,
      strength: v.strength,
    })),
    excluded: report.summary.excluded,
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
 * The review id the temp table hangs on: `<epochSeconds>-<pid>-<6 alnum>`,
 * minted to the store's validation pattern `/^\d{10}-\d{1,7}-[a-z0-9]{6}$/`
 * exactly — the pattern is the injection guard for a SQL identifier that
 * cannot travel as a bind parameter.
 */
export function mintReviewId(epochSeconds: number): string {
  let token = "";
  for (let i = 0; i < 6; i++) token += REVIEW_ID_ALPHABET[randomInt(REVIEW_ID_ALPHABET.length)];
  return `${String(epochSeconds).padStart(10, "0")}-${process.pid}-${token}`;
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

    // Cleanup layer 2 — sweep-on-create: a crashed process's tables die on the
    // next review anywhere, before this one mints its own.
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    await graphDb.sweepExpiredReviewFileEdges(nowEpochSeconds, REVIEW_EDGE_MAX_AGE_SECONDS);
    const reviewId = mintReviewId(nowEpochSeconds);
    try {
      // The indexed side, read once: the graph rows the traversal serves and
      // the report-derived facts the catalogue answers from.
      const production = await readProductionArchitectureGraph(graphDb);
      const facts = deriveArchitectureComponentFacts(production.graph);
      const catalog = new ArchitectureFactsCatalog(
        facts,
        distanceFromMainSequenceByComponent(facts.components, production.graph.files),
      );
      const graph = new WiredGraphReader(production.graph.edges);
      const contract = new WiredContractReader(facts.components, production.graph.edges);
      const splitMerge = wireSplitMerge(context.temporalCochange, context.temporalCochangeError, facts.components);
      // The production silent-coupling verdict over the SAME snapshot (bd
      // tea-rags-mcp-89k7k.1.10) — the run consumes it, never re-judges raw
      // pairs.
      const silentCouplingFacts = buildSilentCouplingFacts(
        context.temporalCochange,
        production.graph.files,
        production.graph.edges,
      );

      // The working-tree side: every scope file the extraction can walk, one
      // shared run-level context; a file that cannot be read or resolved lands
      // in the overlay's unsupported reads — notJudged, never edge-free.
      const extractionContext = workingTreeExtractionContext(scope.workTree, reviewEdgeExtraction.languageFactory);
      const reads: ReviewFileEdgeRead[] = [];
      for (const relPath of scope.files) {
        reads.push(await readReviewFileEdges(reviewEdgeExtraction, scope.workTree, relPath, extractionContext));
      }
      await graphDb.putReviewFileEdges(
        reviewId,
        reads.flatMap((read) => [...read.edges]),
      );

      // The SAME reads feed the overlay — the table is persistence, the
      // overlay is the judgement's view; neither re-reads the other.
      const overlay = new ReviewEdgeOverlay(reads);
      const result = new DiffDetectorRun({ graph, catalog, silentCouplingFacts, contract, ...splitMerge }).run(
        {
          changedFiles: scope.files,
          // A truncated scope marks every built family partial (bd
          // tea-rags-mcp-89k7k.1.9): the cap's skipped files never reach the
          // overlay, so a family's zero can rest on edges it never saw.
          ...(scope.skipped > 0 ? { skippedFiles: scope.skipped } : {}),
        },
        overlay,
      );
      const { kept, truncatedByDetector } = capFindingsByFamily(result.findings, ARCHITECTURE_FINDING_CAP);
      const notJudged: ReviewSectionNotJudgedEntry[] = overlay.unsupported().map((skip) => ({
        relPath: skip.relPath,
        reason: skip.reason,
        ...(skip.detail !== undefined ? { detail: skip.detail } : {}),
      }));
      return {
        findings: kept,
        detectors: result.detectors.map((status) => {
          const truncated = truncatedByDetector.get(status.detector);
          return truncated === undefined ? status : { ...status, truncated };
        }),
        ...(result.findings.length > kept.length ? { truncated: result.findings.length - kept.length } : {}),
        ...(notJudged.length > 0 ? { notJudged } : {}),
      };
    } finally {
      // Cleanup layer 1 — the finally-drop, idempotent (`DROP TABLE IF EXISTS`)
      // and failure-tolerant: a drop error never masks the answer above it,
      // and the age sweep collects whatever it leaves.
      await graphDb.dropReviewFileEdges(reviewId).catch(() => undefined);
    }
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
 *    never fully starved, whatever the others' volume (families ≤ 7, cap 100,
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

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
