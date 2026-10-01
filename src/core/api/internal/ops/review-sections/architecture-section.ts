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
 * a snapshot that is absent, never built, or unreadable degrades the coupling
 * port to no partners — the run's silence contract — while the
 * `incompleteChange` section reports the unreadable case when it was asked
 * for. An empty diff is a VALID review: built, no findings.
 */

import { randomInt } from "node:crypto";

import { REVIEW_EDGE_MAX_AGE_SECONDS } from "../../../../adapters/duckdb/review-edge-store.js";
import type { FileDependencyEdge, TemporalCochangeGraph } from "../../../../contracts/types/codegraph.js";
import type { ReviewSectionNotJudgedEntry } from "../../../public/dto/review.js";
import {
  ArchitectureFactsCatalog,
  deriveArchitectureComponentFacts,
  distanceFromMainSequenceByComponent,
  readProductionArchitectureGraph,
} from "../architecture-facts.js";
import {
  DiffDetectorRun,
  type DiffDetectorCouplingReader,
  type DiffDetectorGraphReader,
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
 * `DiffDetectorCouplingReader` over the pre-read co-change snapshot: the pair
 * table is undirected (stored once, `relPathA < relPathB`), so a file's
 * partners are its rows on EITHER side. `null`/`undefined` — no build, or not
 * read for this review — answers no partners: absence is the run's silence,
 * never a zero verdict.
 */
export class WiredCouplingReader implements DiffDetectorCouplingReader {
  private readonly partnersByFile: ReadonlyMap<string, readonly { partner: string; support: number }[]>;

  constructor(snapshot: TemporalCochangeGraph | null | undefined) {
    const partners = new Map<string, { partner: string; support: number }[]>();
    if (snapshot) {
      for (const edge of snapshot.edges) {
        pushTo(partners, edge.relPathA, { partner: edge.relPathB, support: edge.support });
        pushTo(partners, edge.relPathB, { partner: edge.relPathA, support: edge.support });
      }
    }
    this.partnersByFile = partners;
  }

  partnersOf(relPath: string): readonly { partner: string; support: number }[] {
    return this.partnersByFile.get(relPath) ?? EMPTY_PARTNERS;
  }
}

const EMPTY_PARTNERS: readonly { partner: string; support: number }[] = [];

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
      const coupling = new WiredCouplingReader(context.temporalCochange);

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
      const result = new DiffDetectorRun({ graph, catalog, coupling }).run({ changedFiles: scope.files }, overlay);
      const findings = result.findings.slice(0, ARCHITECTURE_FINDING_CAP);
      const notJudged: ReviewSectionNotJudgedEntry[] = overlay.unsupported().map((skip) => ({
        relPath: skip.relPath,
        reason: skip.reason,
        ...(skip.detail !== undefined ? { detail: skip.detail } : {}),
      }));
      return {
        findings,
        detectors: result.detectors,
        ...(result.findings.length > findings.length ? { truncated: result.findings.length - findings.length } : {}),
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

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
