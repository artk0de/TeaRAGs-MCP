/**
 * Read side of the temporal co-change sub-graph (bd tea-rags-mcp-l1ot.1):
 * a queried file's stored partners, each normalized to the queried file's
 * perspective and ranked by Wilson lower-bound strength.
 *
 * The store's `readGraph` already resolved `structurallyLinked` (file edges,
 * type-only imports, resolved method edges, re-export barrel chains) — this
 * module never re-judges linkage, it only shapes and ranks the answer. The
 * liveness predicate, when given, drops a partner whose file is gone from the
 * working tree before the limit applies: the stored graph is only as fresh as
 * the last build, and a file deleted afterwards must never resurface.
 */
import type { RelPath, TemporalCochangeGraph } from "../../../../../contracts/types/codegraph.js";
import { cochangeStrength } from "../boundary-diagnostics/index.js";

/** One partner of the queried file, from the queried file's perspective. */
export interface RankedCochangePartner {
  relPath: RelPath;
  /** Admitted bundles touching both files. */
  support: number;
  /** P(partner changes | file changes) — the stored confidence, flipped when the pair was stored the other way round. */
  pPartnerGivenFile: number;
  /** P(file changes | partner changes). */
  pFileGivenPartner: number;
  /** Wilson lower bound on the co-change rate, max of both directions. */
  strength: number;
  lift: number;
  lastCoChangeAt: number;
  sampleCommits: string[];
  structurallyLinked: boolean;
}

/** One queried file's answer. */
export interface FileCochangeRanking {
  relPath: RelPath;
  /** The built graph holds at least one stored partner for the file. */
  inGraph: boolean;
  /** Live partners, ranked — `strength` desc, `support` desc, path asc as the deterministic tiebreak. */
  partners: RankedCochangePartner[];
}

/** Per-file partner cap when the request names none (the `limit` default the schema hint states). */
export const DEFAULT_COCHANGE_PARTNERS_LIMIT = 10;

export function rankCochangePartners(
  graph: TemporalCochangeGraph,
  files: readonly RelPath[],
  limit: number = DEFAULT_COCHANGE_PARTNERS_LIMIT,
  pathExists?: (relPath: RelPath) => boolean,
): FileCochangeRanking[] {
  const unique = [...new Set(files)];
  const partnerLists = new Map(unique.map((f) => [f, [] as RankedCochangePartner[]]));
  for (const edge of graph.edges) {
    const fromA = partnerLists.get(edge.relPathA);
    if (fromA) {
      fromA.push(partnerOf(edge, edge.relPathB, edge.confidenceAB, edge.confidenceBA));
    }
    const fromB = partnerLists.get(edge.relPathB);
    if (fromB) {
      fromB.push(partnerOf(edge, edge.relPathA, edge.confidenceBA, edge.confidenceAB));
    }
  }
  return unique.map((relPath) => {
    const stored = partnerLists.get(relPath) ?? [];
    const live = pathExists ? stored.filter((p) => pathExists(p.relPath)) : stored;
    const partners = live
      .sort((a, b) => b.strength - a.strength || b.support - a.support || comparePaths(a.relPath, b.relPath))
      .slice(0, Math.max(0, limit));
    return { relPath, inGraph: stored.length > 0, partners };
  });
}

function partnerOf(
  edge: TemporalCochangeGraph["edges"][number],
  relPath: RelPath,
  pPartnerGivenFile: number,
  pFileGivenPartner: number,
): RankedCochangePartner {
  return {
    relPath,
    support: edge.support,
    pPartnerGivenFile,
    pFileGivenPartner,
    strength: cochangeStrength(edge),
    lift: edge.lift,
    lastCoChangeAt: edge.lastCoChangeAt,
    sampleCommits: edge.sampleCommits,
    structurallyLinked: edge.structurallyLinked,
  };
}

function comparePaths(a: RelPath, b: RelPath): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
