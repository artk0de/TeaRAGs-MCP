/**
 * The `norms` review section (bd tea-rags-mcp-xb669.3): the dependency-norm
 * verdict for every file edge a change ADDS. The edges come from the same
 * reads the `architecture` section judges (`readReviewChangeEdges`: the
 * working-tree overlay and the diff base), classified by the run's own
 * before-the-change evidence (`diffAddedEdges` / `diffRemovedEdgeCount`); the
 * verdict is the whole-repo report's (`judgePlannedEdge` over
 * `buildNormLedgers`). This section owns only the mapping and the wiring.
 *
 * Ledgers are built over the INDEXED production graph, never the overlay: the
 * change's own edges must not be their own precedent (owner decision
 * 2026-10-13). Roles come from the index's type rows, so a file the index
 * does not hold has no role and its edges are UNJUDGED. Read-time only — no
 * index writes.
 *
 * Exclusions: the report never judges an edge whose evidence is a nested
 * constant, a call-less reference, a framework-routed call, or a displaced
 * role. The test is the report's own (`normEdgeExclusionResolver`), wired by
 * {@link buildNormsEdgeExclusionCheck}. An overlay edge carries neither call
 * data nor the reference text, so `uncalled`, `frameworkRouted` and
 * `constantReference` are never evaluated here; only `displacedRole` is. Every
 * class not evaluated is listed on each judged row as `exclusionsUnchecked`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DependencyNormFileRole, FileDependencyGraph, RelPath } from "../../../../contracts/types/codegraph.js";
import {
  buildDependencyNormFilePrimaryTypes,
  buildDependencyNormFileRoles,
} from "../../../../domains/explore/naming-lexicon/index.js";
import {
  buildNormLedgers,
  judgePlannedEdge,
  normEdgeExclusionResolver,
  weakSideOf,
  type DependencyNormsInput,
} from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type {
  NormsAddedEdgeVerdict,
  NormsAddedEdgeVerdictKind,
  NormsEdgeExclusionClass,
  NormsSectionResult,
  NormsUnjudgedReason,
  NormsWeakSide,
  ReviewSectionNotJudgedEntry,
} from "../../../public/dto/review.js";
import { readProductionArchitectureGraph } from "../architecture-facts.js";
import { readDependencyNormTypeNameRows } from "../architecture-graph-facts.js";
import { diffAddedEdges, diffRemovedEdgeCount } from "../diff-detector-run.js";
import { readReviewChangeEdges, WiredGraphReader } from "./architecture-section.js";
import type { ReviewSectionProvider } from "./review-section-provider.js";

/** Verdicts the section lists; the rest are counted in `truncated`. */
export const NORMS_VERDICT_CAP = 100;

/** Every exclusion class the whole-repo norms report applies, in its evaluation order. */
const NORMS_EXCLUSION_CLASSES: readonly NormsEdgeExclusionClass[] = [
  "uncalled",
  "frameworkRouted",
  "constantReference",
  "displacedRole",
];

/** The listing order: what a reviewer must act on first. */
const VERDICT_RANK: Record<NormsAddedEdgeVerdictKind, number> = { MISFIT: 0, NEW_PATTERN: 1, CONFORMS: 2, UNJUDGED: 3 };

/** One added (source, target) file pair. */
interface NormsAddedEdge {
  source: string;
  target: string;
}

/**
 * An exclusion test the review can evaluate for an added edge: the classes it
 * covers and the class (if any) the edge falls in. Absent = none evaluated.
 */
export interface NormsEdgeExclusionCheck {
  classes: readonly NormsEdgeExclusionClass[];
  classify: (edge: NormsAddedEdge) => NormsEdgeExclusionClass | undefined;
}

/**
 * The exclusion check over the report's single definition. The edge handed to
 * the resolver is evidence-free (no `callWeight`, no `importText` — an overlay
 * edge has neither), so the resolver can only answer `displacedRole`, and that
 * is the only class this check claims to cover.
 */
export function buildNormsEdgeExclusionCheck(input: DependencyNormsInput): NormsEdgeExclusionCheck {
  const exclusionOf = normEdgeExclusionResolver(input);
  return {
    classes: ["displacedRole"],
    classify: ({ source, target }) => {
      const sourceRole = input.fileRoles.get(source);
      const targetRole = input.fileRoles.get(target);
      if (sourceRole === undefined || targetRole === undefined) return undefined;
      const exclusion = exclusionOf({ targetRelPath: target }, sourceRole, targetRole);
      return exclusion === "displacedRole" ? exclusion : undefined;
    },
  };
}

export interface AddedEdgeNormsInput {
  addedEdges: readonly NormsAddedEdge[];
  removedEdgeCount: number;
  /** The INDEXED production graph — the ledgers' only precedent. */
  indexedGraph: FileDependencyGraph;
  fileRoles: ReadonlyMap<RelPath, DependencyNormFileRole>;
  filePrimaryTypes?: ReadonlyMap<RelPath, string>;
  /** Non-production paths (tests, tooling) — an edge touching one is counted, not judged. */
  isNonProduction?: (relPath: string) => boolean;
  exclusions?: NormsEdgeExclusionCheck;
  cap?: number;
}

/**
 * The verdict for every added edge, ledgers over the indexed graph only.
 * Locality does not enter the verdict (the direction test pools it), so the
 * ledgers are built without the domain partition.
 */
export function judgeAddedEdgeNorms(input: AddedEdgeNormsInput): NormsSectionResult {
  const { indexedGraph, fileRoles, exclusions } = input;
  const book = buildNormLedgers({
    graph: indexedGraph,
    fileRoles,
    ...(input.filePrimaryTypes !== undefined ? { filePrimaryTypes: input.filePrimaryTypes } : {}),
  });
  const languageOf = new Map(indexedGraph.files.map((f) => [f.relPath, f.language]));
  const checked = new Set(exclusions?.classes ?? []);
  const exclusionsUnchecked = NORMS_EXCLUSION_CLASSES.filter((exclusion) => !checked.has(exclusion));

  const judgeOne = (edge: NormsAddedEdge): NormsAddedEdgeVerdict => {
    const unjudged = (reason: NormsUnjudgedReason, roles = {}, weakSide?: NormsWeakSide): NormsAddedEdgeVerdict => ({
      ...edge,
      verdict: "UNJUDGED",
      ...roles,
      reason,
      ...(weakSide !== undefined ? { weakSide } : {}),
    });
    const sourceLanguage = languageOf.get(edge.source);
    const targetLanguage = languageOf.get(edge.target);
    if (sourceLanguage === undefined || targetLanguage === undefined) return unjudged("notIndexed");
    const sourceRole = fileRoles.get(edge.source);
    const targetRole = fileRoles.get(edge.target);
    if (sourceRole === undefined || targetRole === undefined) return unjudged("untypedRole");
    const weakSide = weakSideOf(sourceRole, targetRole);
    if (weakSide !== undefined) return unjudged("weakRole", {}, weakSide);
    const roles = { roleSrc: sourceRole.role, roleDst: targetRole.role };
    const ledgers = book.forEdge(sourceLanguage, targetLanguage);
    if (ledgers === undefined) return unjudged("crossLanguage", roles);
    const exclusion = exclusions?.classify(edge);
    if (exclusion !== undefined) return unjudged(exclusion, roles);
    const verdict = judgePlannedEdge(ledgers, { ...roles, locality: directoryLocality(edge) });
    const evidence = { ...edge, ...roles, pairSupport: verdict.pairSupport, pValue: verdict.pValue };
    if (verdict.kind === "misfit" && verdict.establishedDirection !== undefined) {
      return { ...evidence, verdict: "MISFIT", expectedPath: verdict.establishedDirection, exclusionsUnchecked };
    }
    return {
      ...evidence,
      verdict: verdict.kind === "conforms" ? "CONFORMS" : "NEW_PATTERN",
      exclusionsUnchecked,
    };
  };

  const isNonProduction = input.isNonProduction ?? (() => false);
  const productionEdges = input.addedEdges.filter(
    (edge) => !isNonProduction(edge.source) && !isNonProduction(edge.target),
  );
  const nonProductionEdgeCount = input.addedEdges.length - productionEdges.length;
  const verdicts = productionEdges.map(judgeOne).sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
  const verdictCounts: Record<NormsAddedEdgeVerdictKind, number> = {
    CONFORMS: 0,
    MISFIT: 0,
    NEW_PATTERN: 0,
    UNJUDGED: 0,
  };
  const unjudgedReasonCounts: Partial<Record<NormsUnjudgedReason, number>> = {};
  for (const row of verdicts) {
    verdictCounts[row.verdict]++;
    if (row.verdict === "UNJUDGED" && row.reason !== undefined) {
      unjudgedReasonCounts[row.reason] = (unjudgedReasonCounts[row.reason] ?? 0) + 1;
    }
  }
  const cap = input.cap ?? NORMS_VERDICT_CAP;
  return {
    built: true,
    addedEdgeVerdicts: verdicts.slice(0, cap),
    verdictCounts,
    unjudgedReasonCounts,
    removedEdgeCount: input.removedEdgeCount,
    ...(nonProductionEdgeCount > 0 ? { nonProductionEdgeCount } : {}),
    ...(verdicts.length > cap ? { truncated: verdicts.length - cap } : {}),
  };
}

/** Two-level locality — the norms' own fallback when no domain partition is given. */
function directoryLocality({ source, target }: NormsAddedEdge): "sameDirectory" | "crossDomain" {
  return dirname(source) === dirname(target) ? "sameDirectory" : "crossDomain";
}

export const normsSectionProvider: ReviewSectionProvider = {
  id: "norms",

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
      return { built: false, reason: "norms substrate vanished between isBuilt and run" };
    }
    // The indexed side: the production graph every report detector judges and
    // the type rows its roles come from — the ledgers' only precedent.
    const production = await readProductionArchitectureGraph(
      graphDb,
      context.readIndexedFileImports,
      context.readDeclaredTestDependencies,
    );
    const typeNameRows = await readDependencyNormTypeNameRows(graphDb);
    // The change's side, classified by the run's before-the-change evidence.
    const { overlay, baseEdges } = await readReviewChangeEdges(
      scope,
      reviewEdgeExtraction,
      await context.readIndexedSymbolRows?.(),
    );
    const ports = {
      graph: new WiredGraphReader(production.graph.edges),
      ...(baseEdges !== undefined ? { baseEdges } : {}),
    };
    const deletedFiles = [...scope.touchedFiles].filter((relPath) => !existsSync(join(scope.workTree, relPath)));
    const fileRoles = buildDependencyNormFileRoles(typeNameRows);
    const result = judgeAddedEdgeNorms({
      addedEdges: diffAddedEdges(scope.files, overlay, ports),
      removedEdgeCount: diffRemovedEdgeCount(scope.files, overlay, { ...ports, deletedFiles }),
      indexedGraph: production.graph,
      fileRoles,
      filePrimaryTypes: buildDependencyNormFilePrimaryTypes(typeNameRows),
      exclusions: buildNormsEdgeExclusionCheck({ graph: production.graph, fileRoles }),
      isNonProduction: (relPath) => production.nonProduction.ignores(relPath),
    });
    const notJudged: ReviewSectionNotJudgedEntry[] = overlay.unsupported().map((skip) => ({
      relPath: skip.relPath,
      reason: skip.reason,
      ...(skip.detail !== undefined ? { detail: skip.detail } : {}),
    }));
    return {
      ...result,
      ...(notJudged.length > 0 ? { notJudged } : {}),
      ...(scope.skipped > 0 ? { scopeSkippedFiles: scope.skipped } : {}),
    };
  },
};
