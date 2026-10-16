/**
 * StatusModule - Index status and cleanup operations.
 *
 * Extracted from CodeIndexer to isolate status queries and index clearing.
 *
 * Always reports the latest versioned collection status:
 * - If a newer _v(N+1) is being indexed while alias points to _vN, reports "indexing"
 * - If alias doesn't exist yet (first index in progress), finds _v1 and reports from it
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { hashCollectionForPath, validatePath } from "../../../adapters/filesystem/path-canonicalization.js";
import { StatsCache } from "../../../adapters/filesystem/stats-cache.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { SchemaMetadataPointStore } from "../../../adapters/qdrant/schema-metadata-point.js";
import { chunkPointsFilter } from "../../../adapters/qdrant/service-points.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import { resolveRateMiss } from "../../../contracts/resolve-rate.js";
import type { GraphDbClientPoolPort } from "../../../contracts/types/codegraph-pool.js";
import type {
  EdgeKindCount,
  GraphDbClient,
  MethodEdgeKind,
  ModelResolvedSiteCount,
  ResolveRunStatsRow,
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { PathCollectionResolver } from "../../../contracts/types/registry.js";
import { isDebug } from "../../../primitives/diagnostics/index.js";
import type {
  CodegraphModelResolutionRow,
  CodegraphResolveKindRow,
  CodegraphResolveLanguageRow,
  CodegraphResolveSummary,
  EdgeKindBreakdown,
  IndexStatus,
} from "../../../types.js";
import {
  MIN_LANGUAGE_SHARE,
  parseMarkerPayload,
  STALE_INDEXING_THRESHOLD_MS,
  type IndexingLockLivenessProbe,
} from "../infra/index.js";
import { ParallelFileSynchronizer, QuarantineStore } from "../sync/index.js";
import { mapMarkerToHealth } from "./enrichment/health-mapper.js";

// The threshold itself lives with the marker codec: `infra/alias-cleanup` reads
// the same number to decide whether a half-built collection may be reclaimed,
// and the two must not drift. Status keeps its own undated-marker handling
// below — an undated marker reads as live here, dead there, on purpose.

/** Running tally aggregated from `cg_run_stats` rows (per language or per kind). */
interface ResolveTally {
  attempted: number;
  resolved: number;
  externalSkipped: number;
  unresolvable: number;
  noInProjectDef: number;
  coreAmbiguous: number;
  ambiguousFanout: number;
  // bd tea-rags-mcp-znxg8 — RESOLVED calls that stopped at a shared self-dispatch
  // entry node. Feeds no rate: it is an invariant, not a miss bucket.
  unnarrowedTemplate: number;
  // bd tea-rags-mcp-2m83f.43 — residual sites settled statically by receiver
  // narrowing (a subset of `resolved`), and those that intersected to no class.
  narrowed: number;
  narrowEmpty: number;
}

function emptyTally(): ResolveTally {
  return {
    attempted: 0,
    resolved: 0,
    externalSkipped: 0,
    unresolvable: 0,
    noInProjectDef: 0,
    coreAmbiguous: 0,
    ambiguousFanout: 0,
    unnarrowedTemplate: 0,
    narrowed: 0,
    narrowEmpty: 0,
  };
}

/**
 * Genuine recall holes in a tally. The exclusion list lives in
 * `contracts/resolve-rate.ts#resolveRateMiss`, shared with the renderers that
 * must tell an empty denominator from a scored one, so the three rates below
 * and every rendering of them can never drift apart.
 */
function missWithInProjectDef(t: ResolveTally): number {
  return resolveRateMiss(t);
}

/**
 * `resolved / (resolved + missWithInProjectDef)`; `null` when that denominator
 * is empty — nothing was scored, which is neither a perfect nor a failed rate
 * (bd tea-rags-mcp-qodqg). cai0.2 (Option A): the denominator excludes calls
 * whose member has no in-project def — they can never resolve to an in-project
 * symbol, so they are not resolver failures — making this rate equal to
 * {@link edgeRecall} (inProjectEdgeRecall) whenever anything was scored. 83cl7
 * adds core homonyms on the same grounds.
 */
function resolveRate(t: ResolveTally): number | null {
  const denominator = t.resolved + missWithInProjectDef(t);
  return denominator === 0 ? null : t.resolved / denominator;
}

/**
 * Graph completeness: `resolved / (resolved + missWithInProjectDef)` — see
 * {@link missWithInProjectDef} for what is excluded. `null` when the
 * denominator is empty — nothing was scored, the same value {@link resolveRate}
 * reports (bd tea-rags-mcp-stpvj). A scored zero stays 0.
 */
function edgeRecall(t: ResolveTally): number | null {
  const denominator = t.resolved + missWithInProjectDef(t);
  return denominator === 0 ? null : t.resolved / denominator;
}

/**
 * bd tea-rags-mcp-f2jsb / j0pki — dual-recall companion to {@link edgeRecall}:
 * `(resolved + ambiguousFanout) / SAME denominator`. An over-cap ambiguous
 * fan-out stays a miss for STRICT recall (it produced no edge), but its
 * aggregate record still covers the call site — coveredRecall reports
 * completeness when that aggregate is accepted as coverage. `null` when the
 * denominator is empty (bd tea-rags-mcp-stpvj).
 */
function coveredRecall(t: ResolveTally): number | null {
  const denominator = t.resolved + missWithInProjectDef(t);
  return denominator === 0 ? null : (t.resolved + t.ambiguousFanout) / denominator;
}

/**
 * Fold the per-`edge_kind` counts into the precision-confidence breakdown.
 * `exactRatio` = exact / total — the rest (cone / poly-base / dynamic) are
 * fan-out over-approximations with confidence < 1. `registry` (dispatch-table
 * pinned) is reported but NOT counted as exact.
 */
function buildEdgeKindBreakdown(counts: readonly EdgeKindCount[]): EdgeKindBreakdown {
  // A model edge is stored as `exact` but is probabilistic: its own bucket (2m83f.38).
  const isModel = (c: EdgeKindCount): boolean => c.origin === "model";
  const by = (k: MethodEdgeKind): number =>
    counts.filter((c) => c.edgeKind === k && !isModel(c)).reduce((sum, c) => sum + c.count, 0);
  const exact = by("exact");
  const cone = by("cone");
  const polyBase = by("poly-base");
  const dynamic = by("dynamic");
  const registry = by("registry");
  const model = counts.filter(isModel).reduce((sum, c) => sum + c.count, 0);
  const total = exact + cone + polyBase + dynamic + registry + model;
  return { exact, cone, polyBase, dynamic, registry, model, total, exactRatio: total === 0 ? 0 : exact / total };
}

/**
 * What the residual pass resolved, folded into the resolve tally (bd
 * tea-rags-mcp-2m83f.38). `thresholds` names the threshold each model's edges
 * were counted at.
 */
export interface ModelResolvedSites {
  counts: readonly ModelResolvedSiteCount[];
  thresholds: Readonly<Record<string, number>>;
}

/** Model-resolved and model-external (2m83f.45) residual sites by the static bucket they leave. */
interface ModelSiteTally {
  ambiguous: number;
  dynamic: number;
  externalAmbiguous: number;
  externalDynamic: number;
}

function emptyModelSiteTally(): ModelSiteTally {
  return { ambiguous: 0, dynamic: 0, externalAmbiguous: 0, externalDynamic: 0 };
}

function addModelSites(tallies: Map<string, ModelSiteTally>, key: string, c: ModelResolvedSiteCount): void {
  const t = tallies.get(key) ?? emptyModelSiteTally();
  addModelSiteCount(t, c);
  tallies.set(key, t);
}

function addModelSiteCount(t: ModelSiteTally, c: ModelResolvedSiteCount): void {
  if (c.outcome === "external") {
    if (c.kind === "ambiguous") t.externalAmbiguous += c.sites;
    else t.externalDynamic += c.sites;
    return;
  }
  t[c.kind] += c.sites;
}

/**
 * The static tally with the model-resolved sites moved into `resolved`, then
 * the sites a model put outside the project moved into `externalSkipped` (out
 * of the denominator): an ambiguous site out of `ambiguousFanout`, a dynamic
 * one out of the in-project miss. Never moves more than the bucket holds, so a
 * residual table read against another generation's run stats cannot push recall
 * past 1.
 */
function withModelSites(
  t: ResolveTally,
  m: ModelSiteTally | undefined,
): { combined: ResolveTally; moved: number; external: number } {
  if (m === undefined) return { combined: t, moved: 0, external: 0 };
  const ambiguous = Math.min(m.ambiguous, t.ambiguousFanout);
  const dynamic = Math.min(m.dynamic, Math.max(0, missWithInProjectDef(t) - t.ambiguousFanout));
  const moved = ambiguous + dynamic;
  const afterEdges: ResolveTally = {
    ...t,
    resolved: t.resolved + moved,
    ambiguousFanout: t.ambiguousFanout - ambiguous,
  };
  const externalAmbiguous = Math.min(m.externalAmbiguous, afterEdges.ambiguousFanout);
  const externalDynamic = Math.min(
    m.externalDynamic,
    Math.max(0, missWithInProjectDef(afterEdges) - afterEdges.ambiguousFanout),
  );
  const external = externalAmbiguous + externalDynamic;
  return {
    combined: {
      ...afterEdges,
      externalSkipped: afterEdges.externalSkipped + external,
      ambiguousFanout: afterEdges.ambiguousFanout - externalAmbiguous,
    },
    moved,
    external,
  };
}

function modelResolutionRows(modelResolvedSites: ModelResolvedSites): CodegraphModelResolutionRow[] {
  const byModel = new Map<string, { sites: number; external: number }>();
  for (const c of modelResolvedSites.counts) {
    const m = byModel.get(c.model) ?? { sites: 0, external: 0 };
    if (c.outcome === "external") m.external += c.sites;
    else m.sites += c.sites;
    byModel.set(c.model, m);
  }
  return [...byModel.entries()]
    .filter(([, m]) => m.sites + m.external > 0)
    .map(([model, m]) => {
      const threshold = modelResolvedSites.thresholds[model];
      return {
        model,
        ...(threshold === undefined ? {} : { threshold }),
        sites: m.sites,
        ...(m.external > 0 ? { external: m.external } : {}),
      };
    })
    .sort((a, b) => b.sites - a.sites);
}

/**
 * Residual sites a model resolved; empty when the read fails, so a daemon
 * without the op still reports the static figures.
 */
async function readModelResolvedSites(
  graphDb: Pick<GraphDbClient, "getModelResolvedSiteCounts">,
  thresholds: Readonly<Record<string, number>>,
): Promise<ModelResolvedSiteCount[]> {
  try {
    return await graphDb.getModelResolvedSiteCounts(thresholds);
  } catch {
    return [];
  }
}

/**
 * Build the per-receiver-kind breakdown for one language (bd tea-rags-mcp-7m5xz).
 * Includes a kind only when it was actually attempted (`attempted > 0`) — NO
 * min-share filter, since small buckets (e.g. `selfMember`) are the target.
 * Sorted by `attempted` DESC; per-kind `resolveSuccessRate` reuses the shared
 * {@link resolveRate} helper so the external-skip exclusion stays consistent.
 */
function buildByReceiverKind(
  kinds: Map<string, ResolveTally>,
  modelKinds?: ReadonlyMap<string, ModelSiteTally>,
): CodegraphResolveKindRow[] {
  return [...kinds.entries()]
    .filter(([, t]) => t.attempted > 0)
    .map(([receiverKind, staticTally]) => {
      const { combined: t, moved, external } = withModelSites(staticTally, modelKinds?.get(receiverKind));
      return { receiverKind, staticTally, t, moved, external };
    })
    .map(({ receiverKind, staticTally, t, moved, external }) => ({
      receiverKind,
      inProjectEdgeRecall: edgeRecall(t),
      coveredRecall: coveredRecall(t),
      ...(moved + external > 0 ? { staticInProjectEdgeRecall: edgeRecall(staticTally) } : {}),
      attempted: t.attempted,
      resolved: t.resolved,
      ...(moved > 0 ? { resolvedByModel: moved } : {}),
      ...(external > 0 ? { externalByModel: external } : {}),
      externalSkipped: t.externalSkipped,
      unresolvable: t.unresolvable,
      callsNoInProjectDef: t.noInProjectDef,
      callsCoreAmbiguous: t.coreAmbiguous,
      ambiguousFanout: t.ambiguousFanout,
      callsUnnarrowedTemplate: t.unnarrowedTemplate,
      resolveSuccessRate: resolveRate(t),
    }))
    .sort((a, b) => b.attempted - a.attempted);
}

/** Receiver-narrowing counters, present only once a run narrowed or failed to narrow a site. */
function narrowingCounts(t: ResolveTally): { callsNarrowed?: number; callsNarrowEmpty?: number } {
  return t.narrowed > 0 || t.narrowEmpty > 0 ? { callsNarrowed: t.narrowed, callsNarrowEmpty: t.narrowEmpty } : {};
}

/**
 * Accumulate one persisted row into a tally. Columns added by a later migration
 * default to 0 for rows written before it (`unresolvable` 010, `no_in_project_def`
 * 011, `ambiguous_fanout` 013, `core_ambiguous` 015) — an old index then reads
 * its pre-migration rate until the next re-index repopulates the columns.
 */
function addRow(t: ResolveTally, r: ResolveRunStatsRow): void {
  t.attempted += r.attempted;
  t.resolved += r.resolved;
  t.externalSkipped += r.externalSkipped;
  t.unresolvable += r.unresolvable ?? 0;
  t.noInProjectDef += r.noInProjectDef ?? 0;
  t.coreAmbiguous += r.coreAmbiguous ?? 0;
  t.ambiguousFanout += r.ambiguousFanout ?? 0;
  t.unnarrowedTemplate += r.unnarrowedTemplate ?? 0;
  t.narrowed += r.narrowed ?? 0;
  t.narrowEmpty += r.narrowEmpty ?? 0;
}

/**
 * Fold the persisted per-(language, receiverKind) `cg_run_stats` rows into the
 * status DTO (bd tea-rags-mcp-cnqrg). The aggregate sums every row; the
 * per-language breakdown sums per language, then applies the SAME display rule
 * as `get_index_metrics` — drop a language whose call-site share is below
 * {@link MIN_LANGUAGE_SHARE} (noise) — and omits the breakdown entirely when ≤1
 * language survives (the aggregate already conveys it). "Officially supported"
 * needs no extra filter: only resolver-backed code languages reach the tally,
 * and unlabeled rows (`language: ""`, direct-mode) are excluded from the
 * per-language view. Returns `undefined` when there are no rows.
 *
 * tea-rags-mcp-7m5xz — the same rows ALSO fold into a per-receiver-kind
 * breakdown, placed by MIRRORING the byLanguage suppression: when >1 language
 * survives, `byReceiverKind` is attached to EACH byLanguage row (precise
 * lang×kind) and the top-level stays absent; when exactly 1 language survives
 * (byLanguage suppressed), the top-level `byReceiverKind` carries that single
 * language's kinds.
 */
export function summarizeCodegraphResolve(
  rows: readonly ResolveRunStatsRow[],
  edgeCounts?: readonly EdgeKindCount[],
  modelResolved?: ModelResolvedSites,
): CodegraphResolveSummary | undefined {
  if (rows.length === 0) return undefined;
  // tea-rags-mcp-7m5xz follow-up: byReceiverKind is verbose — it is computed and
  // attached ONLY under DEBUG. The single gate point is this flag: when false,
  // the per-(language, receiverKind) tally is never built, so `buildByReceiverKind`
  // is never called and the field is absent from both the per-byLanguage rows
  // (nested) and the single-language top-level case. The prime `## Codegraph
  // resolve` per-kind section auto-omits when no breakdown is present.
  const debug = isDebug();
  const total = emptyTally();
  const byLang = new Map<string, ResolveTally>();
  // Per-language receiver-kind tally (bd tea-rags-mcp-7m5xz). Unlabeled rows are
  // excluded here exactly as they are for byLanguage. Populated only under DEBUG.
  const byLangKind = new Map<string, Map<string, ResolveTally>>();
  for (const r of rows) {
    addRow(total, r);
    if (!r.language) continue; // unlabeled (pre-cnqrg / direct-mode) — aggregate only
    const e = byLang.get(r.language) ?? emptyTally();
    addRow(e, r);
    byLang.set(r.language, e);
    if (!debug) continue; // short form: skip receiver-kind tally entirely
    const kinds = byLangKind.get(r.language) ?? new Map<string, ResolveTally>();
    const k = kinds.get(r.receiverKind) ?? emptyTally();
    addRow(k, r);
    kinds.set(r.receiverKind, k);
    byLangKind.set(r.language, kinds);
  }
  // bd tea-rags-mcp-2m83f.38 — model-resolved residual sites, keyed like the
  // static tallies. A pre-055 row carries no receiver kind and so sits in no
  // per-kind row; one with no language either folds into the aggregate only.
  const modelTotal = emptyModelSiteTally();
  const modelByLang = new Map<string, ModelSiteTally>();
  const modelByLangKind = new Map<string, Map<string, ModelSiteTally>>();
  let modelUnlabeled = 0;
  for (const c of modelResolved?.counts ?? []) {
    addModelSiteCount(modelTotal, c);
    if (c.receiverKind === null && c.outcome !== "external") modelUnlabeled += c.sites;
    if (c.language === null) continue;
    addModelSites(modelByLang, c.language, c);
    if (c.receiverKind === null) continue;
    const kinds = modelByLangKind.get(c.language) ?? new Map<string, ModelSiteTally>();
    addModelSites(kinds, c.receiverKind, c);
    modelByLangKind.set(c.language, kinds);
  }
  const staticTotal = total;
  const {
    combined: combinedTotal,
    moved: movedTotal,
    external: externalTotal,
  } = withModelSites(staticTotal, modelTotal);
  const summary: CodegraphResolveSummary = {
    // Recall is the always-on graph-completeness number. resolveSuccessRate is
    // kept DEBUG-only as the explicit-rate view; under cai0.2 (Option A) its
    // denominator also excludes noInProjectDef, so it now EQUALS
    // inProjectEdgeRecall (the former "denominator-polluted" gap is closed —
    // collapsing the two fields into one is a separate DTO decision).
    inProjectEdgeRecall: edgeRecall(combinedTotal),
    // bd f2jsb / j0pki — dual recall: strict above (ambiguous stays a miss in
    // the denominator), covered below (the aggregate counts as coverage).
    coveredRecall: coveredRecall(combinedTotal),
    callsAttempted: combinedTotal.attempted,
    callsResolved: combinedTotal.resolved,
    callsExternalSkipped: combinedTotal.externalSkipped,
    callsUnresolvable: combinedTotal.unresolvable,
    callsNoInProjectDef: combinedTotal.noInProjectDef,
    callsCoreAmbiguous: combinedTotal.coreAmbiguous,
    ambiguousFanout: combinedTotal.ambiguousFanout,
    callsUnnarrowedTemplate: combinedTotal.unnarrowedTemplate,
    ...narrowingCounts(combinedTotal),
    ...(debug ? { resolveSuccessRate: resolveRate(combinedTotal) } : {}),
  };
  if (movedTotal + externalTotal > 0 && modelResolved !== undefined) {
    summary.staticInProjectEdgeRecall = edgeRecall(staticTotal);
    if (movedTotal > 0) summary.callsResolvedByModel = movedTotal;
    if (externalTotal > 0) summary.callsExternalByModel = externalTotal;
    summary.modelResolution = modelResolutionRows(modelResolved);
    if (modelUnlabeled > 0) summary.callsResolvedByModelUnlabeled = modelUnlabeled;
  }
  const byLanguage: CodegraphResolveLanguageRow[] = [...byLang.entries()]
    .filter(([, t]) => total.attempted > 0 && t.attempted / total.attempted >= MIN_LANGUAGE_SHARE)
    .map(([language, staticTally]) => {
      const { combined: t, moved, external } = withModelSites(staticTally, modelByLang.get(language));
      return {
        language,
        inProjectEdgeRecall: edgeRecall(t),
        ...(moved + external > 0 ? { staticInProjectEdgeRecall: edgeRecall(staticTally) } : {}),
        ...(moved > 0 ? { callsResolvedByModel: moved } : {}),
        ...(external > 0 ? { callsExternalByModel: external } : {}),
        callsAttempted: t.attempted,
        callsResolved: t.resolved,
        callsExternalSkipped: t.externalSkipped,
        callsUnresolvable: t.unresolvable,
        callsNoInProjectDef: t.noInProjectDef,
        callsCoreAmbiguous: t.coreAmbiguous,
        callsUnnarrowedTemplate: t.unnarrowedTemplate,
        ...narrowingCounts(t),
        ...(debug ? { resolveSuccessRate: resolveRate(t) } : {}),
        // Absent unless DEBUG built the tally above.
        ...(debug
          ? {
              byReceiverKind: buildByReceiverKind(
                byLangKind.get(language) ?? new Map<string, ResolveTally>(),
                modelByLangKind.get(language),
              ),
            }
          : {}),
      };
    })
    .sort((a, b) => b.callsAttempted - a.callsAttempted);
  if (byLanguage.length > 1) {
    summary.byLanguage = byLanguage;
  } else if (byLanguage.length === 1 && debug) {
    // Single surviving language: byLanguage is suppressed (aggregate conveys it),
    // so surface that language's kind breakdown at the top level — DEBUG only.
    summary.byReceiverKind = byLanguage[0].byReceiverKind;
  }
  if (edgeCounts && edgeCounts.length > 0) summary.edgeKinds = buildEdgeKindBreakdown(edgeCounts);
  return summary;
}

export class StatusModule {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly snapshotDir?: string,
    private readonly codegraphPool?: GraphDbClientPoolPort,
    /**
     * Provider keys of the running composition — the frame of the enrichment
     * health report (bd tea-rags-mcp-x2u65). Supplied by IndexingOps from the
     * EnrichmentCoordinator, which holds the post-toggle provider list. Left
     * empty only when no coordinator is wired, and then a run-pointer marker
     * has no frame to report against.
     */
    private readonly activeEnrichmentProviders: readonly string[] = [],
    /**
     * How a path becomes the collection to report on — the project registry's
     * entry when one claims the path, the path hash otherwise
     * (`createPathCollectionResolver`, bd tea-rags-mcp-dxa9w). Supplied by
     * IndexingOps, which holds the rule the rest of the run resolves by.
     *
     * Hashing here is what made `get_index_status` answer "not indexed" for a
     * relocated project whose data was sitting under the collection its
     * registry entry recorded. Defaults to the hash — what an unregistered
     * path resolves to either way.
     */
    private readonly resolveCollectionForPath: PathCollectionResolver = hashCollectionForPath,
    /**
     * The collection's indexing lock, asked whether the writer of an incomplete
     * marker still runs (bd tea-rags-mcp-f93ao). A lock naming a dead process on
     * this host turns the report to `stale_indexing` at once instead of after the
     * marker heartbeat ages out. Absent → the heartbeat timer alone decides.
     */
    private readonly writerLiveness?: IndexingLockLivenessProbe,
    /**
     * Threshold per residual model (`{ kev: 0.7 }`) of the running
     * configuration (bd tea-rags-mcp-2m83f.38): a model edge counts as resolving
     * its site only at `p` at or above it. Empty → every stored model edge counts.
     */
    private readonly residualThresholds: Readonly<Record<string, number>> = {},
  ) {}

  /**
   * tea-rags-mcp-ykj7 — post-hoc codegraph resolve-quality for an indexed
   * collection, aggregated from the persisted `cg_run_stats` table. Returns
   * `undefined` (non-fatal) when codegraph is disabled, the collection has no
   * codegraph DB on disk, the table is empty, or any read fails — get_index_status
   * must never break because codegraph state is absent. The existence guard
   * (`listCollectionDbNames`, a dir read) prevents a status call from creating a
   * phantom codegraph DB for non-codegraph collections.
   */
  private async readCodegraphResolve(collection: string): Promise<CodegraphResolveSummary | undefined> {
    if (!this.codegraphPool) return undefined;
    // The codegraph DB is keyed by the VERSIONED collection (`code_…_vN`), but
    // the status path usually passes the base/alias name. Resolve to the on-disk
    // DB name WITHOUT creating one — `listCollectionDbNames` is a dir read, so a
    // status call never spins up a phantom codegraph DB for a Qdrant-only
    // collection. Prefer the exact name, then the Qdrant alias target, then the
    // sole version; bail (undefined) on ambiguity rather than guessing.
    const base = collection.replace(/_v\d+$/, "");
    const physicalCollectionNames = this.codegraphPool.listCollectionDbNames(base);
    if (physicalCollectionNames.length === 0) return undefined;
    // Every candidate comes off the directory listing, so whatever is chosen is a
    // name a database was actually opened under (bd tea-rags-mcp-39xca.1).
    let physicalCollectionName: PhysicalCollectionName | undefined = physicalCollectionNames.find(
      (candidatePhysicalCollectionName) => candidatePhysicalCollectionName === collection,
    );
    if (!physicalCollectionName) {
      const aliasTarget = await this.getAliasTarget(base).catch(() => undefined);
      physicalCollectionName =
        physicalCollectionNames.find(
          (candidatePhysicalCollectionName) => candidatePhysicalCollectionName === aliasTarget,
        ) ?? (physicalCollectionNames.length === 1 ? physicalCollectionNames[0] : undefined);
    }
    if (!physicalCollectionName) return undefined;
    try {
      const handle = await this.codegraphPool.acquireReader(physicalCollectionName);
      try {
        const [rows, edgeCounts, modelCounts] = await Promise.all([
          handle.graphDb.getRunStats(),
          handle.graphDb.getEdgeKindDistribution(),
          readModelResolvedSites(handle.graphDb, this.residualThresholds),
        ]);
        return summarizeCodegraphResolve(rows, edgeCounts, {
          counts: modelCounts,
          thresholds: this.residualThresholds,
        });
      } finally {
        await handle.graphDb.close();
      }
    } catch {
      return undefined;
    }
  }

  /**
   * Get indexing status for a codebase.
   *
   * Always shows the latest version — if a newer versioned collection
   * is being indexed (no alias yet, or alias still on old version),
   * reports that indexing is in progress.
   */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    const absolutePath = await validatePath(path);
    const aliasCollectionName = await this.resolveCollectionForPath(absolutePath);

    // Find the latest versioned collection (highest _vN)
    const latestVersioned = await this.findLatestVersionedCollection(aliasCollectionName);

    // Check if alias/real collection exists
    const exists = await this.qdrant.collectionExists(aliasCollectionName);

    if (!exists && !latestVersioned) {
      return { isIndexed: false, status: "not_indexed" };
    }

    // If a versioned collection exists that is newer than what alias points to,
    // report status from it only when it's actually in-progress or crashed
    // mid-index. A complete-but-unaliased _vN is an orphan from a prior
    // rotation (force-reindex deleted the old alias target and left _vN
    // behind), and must not shadow the real alias target.
    if (latestVersioned) {
      const aliasTarget = exists ? await this.getAliasTarget(aliasCollectionName) : undefined;
      if (aliasTarget !== latestVersioned) {
        if (!exists) {
          // No alias/real collection at all — latestVersioned is the only source
          // (first index in progress, or first index that completed but alias was
          // never created).
          return this.getStatusFromCollection(latestVersioned, aliasCollectionName);
        }
        const rawPoint = await this.qdrant.getPoint(latestVersioned, INDEXING_METADATA_ID).catch(() => null);
        const marker = rawPoint ? parseMarkerPayload(rawPoint.payload as Record<string, unknown>) : undefined;
        if (!marker?.indexingComplete) {
          // In-progress or crashed mid-index — report from this collection
          return this.getStatusFromCollection(latestVersioned, aliasCollectionName);
        }
        // Otherwise it's a completed orphan; fall through to read from alias.
      }
    }

    // Alias points to latest version (or legacy real collection) — read from alias
    return this.getStatusFromCollection(aliasCollectionName, aliasCollectionName);
  }

  /**
   * Clear all indexed data for a codebase.
   * Handles both legacy (real collection) and alias-based setups.
   */
  async clearIndex(path: string): Promise<void> {
    const absolutePath = await validatePath(path);
    const aliasCollectionName = await this.resolveCollectionForPath(absolutePath);
    const exists = await this.qdrant.collectionExists(aliasCollectionName);

    if (exists) {
      const isAlias = await this.qdrant.aliases.isAlias(aliasCollectionName);
      if (isAlias) {
        // Alias-based: find underlying collection, delete alias + collection + orphans
        const aliases = await this.qdrant.aliases.listAliases();
        const activePhysicalCollectionName = aliases.find((a) => a.aliasName === aliasCollectionName)?.collectionName;
        await this.qdrant.aliases.deleteAlias(aliasCollectionName);
        if (activePhysicalCollectionName) {
          await this.qdrant.deleteCollection(activePhysicalCollectionName);
        }
        // Clean up any orphaned versioned collections
        const allPhysicalCollectionNames = await this.qdrant.listCollections();
        for (const physicalCollectionName of allPhysicalCollectionNames) {
          if (physicalCollectionName.startsWith(`${aliasCollectionName}_v`)) {
            await this.qdrant.deleteCollection(physicalCollectionName);
          }
        }
      } else {
        // Legacy: real collection, just delete it
        await this.qdrant.deleteCollection(aliasCollectionName);
      }
    }

    // Also delete snapshot
    try {
      /* v8 ignore next -- fallback for backward compat */
      const dir = this.snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");
      const synchronizer = new ParallelFileSynchronizer(absolutePath, aliasCollectionName, dir);
      await synchronizer.deleteSnapshot();
      // The quarantine and stats caches live as siblings of the snapshot dir, so
      // the snapshot delete above does not reach them — drop them explicitly.
      await new QuarantineStore(dir, aliasCollectionName).clearAll();
      new StatsCache(dir).invalidate(aliasCollectionName);
    } catch (_error) {
      // Ignore snapshot deletion errors
    }
  }

  // ── Private helpers ──────────────────────────────────────

  /**
   * Read the poison-pill quarantine count for a collection from its snapshot
   * directory. Returns undefined when no snapshot dir is wired or nothing is
   * quarantined, keeping the status surface narrow.
   */
  private async loadQuarantineSummary(reportedName: string): Promise<{ count: number } | undefined> {
    if (!this.snapshotDir) return undefined;
    const count = await new QuarantineStore(this.snapshotDir, reportedName).count();
    return count > 0 ? { count } : undefined;
  }

  /**
   * Distinct-file count from the persisted collection stats
   * (DistinctPathsAccumulator → Distributions.totalFiles), keyed by public alias.
   * Undefined when no snapshot dir or no stats cached.
   *
   * Why: Qdrant points are chunk-level; file count comes from the
   * DistinctPathsAccumulator → Distributions.totalFiles persisted in StatsCache
   * under the alias.
   */
  private readFileCount(reportedName: string): number | undefined {
    /* v8 ignore next -- fallback mirrors clearIndex dir-resolution */
    const dir = this.snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");
    const stats = new StatsCache(dir).load(reportedName);
    const totalFiles = stats?.distributions.totalFiles;
    return typeof totalFiles === "number" && totalFiles > 0 ? totalFiles : undefined;
  }

  /**
   * Find the latest versioned collection (highest _vN suffix).
   * Returns undefined if no versioned collections exist.
   */
  private async findLatestVersionedCollection(collectionName: string): Promise<string | undefined> {
    const allPhysicalCollectionNames = await this.qdrant.listCollections();
    const versionedPattern = new RegExp(`^${collectionName}_v(\\d+)$`);
    let maxVersion = 0;
    let latest: string | undefined;

    for (const physicalCollectionName of allPhysicalCollectionNames) {
      const match = physicalCollectionName.match(versionedPattern);
      if (match) {
        const version = parseInt(match[1], 10);
        if (version > maxVersion) {
          maxVersion = version;
          latest = physicalCollectionName;
        }
      }
    }

    return latest;
  }

  /**
   * Get the collection name that an alias points to.
   * Returns undefined if the name is not an alias (real collection or not found).
   */
  private async getAliasTarget(aliasName: string): Promise<string | undefined> {
    const aliases = await this.qdrant.aliases.listAliases();
    return aliases.find((a) => a.aliasName === aliasName)?.collectionName;
  }

  /**
   * Read full index status from a specific collection.
   * @param sourceCollection - collection to read markers from (e.g. "code_abc_v1")
   * @param reportedName - collection name to report in the response (always the base alias name)
   */
  private async getStatusFromCollection(sourceCollection: string, reportedName: string): Promise<IndexStatus> {
    const rawPoint = await this.qdrant.getPoint(sourceCollection, INDEXING_METADATA_ID);
    const marker = rawPoint ? parseMarkerPayload(rawPoint.payload as Record<string, unknown>) : undefined;

    // Chunks only, counted server-side under the one service-point definition
    // that metrics, stats and the recompute also use (bd tea-rags-mcp-39xca.12).
    // Subtracting the marker from `pointsCount` missed the schema metadata point.
    const actualChunksCount = await this.qdrant.countPoints(sourceCollection, chunkPointsFilter());
    const enrichment = marker?.enrichment
      ? mapMarkerToHealth(marker.enrichment, this.activeEnrichmentProviders)
      : undefined;

    const schemaMetadata = await new SchemaMetadataPointStore(this.qdrant).read(sourceCollection).catch(() => null);
    const sparseVersion = typeof schemaMetadata?.sparseVersion === "number" ? schemaMetadata.sparseVersion : undefined;

    if (marker && !marker.indexingComplete) {
      // Detect stale indexing: prefer lastHeartbeat (updated periodically by live pipeline),
      // fall back to startedAt for markers written before heartbeat was introduced.
      const referenceTime = marker.lastHeartbeat ?? marker.startedAt;
      const heartbeatExpired =
        referenceTime !== undefined && Date.now() - new Date(referenceTime).getTime() > STALE_INDEXING_THRESHOLD_MS;
      // A writer provably dead on this host is reported at once; deleting what it
      // left stays on the heartbeat timer (bd tea-rags-mcp-f93ao).
      const isStale = heartbeatExpired || (await this.isWriterDead(reportedName));

      if (heartbeatExpired && sourceCollection !== reportedName) {
        const resolved = await this.resolveStaleCollection(sourceCollection, reportedName, actualChunksCount);
        if ("notIndexed" in resolved) {
          return { isIndexed: false, status: "not_indexed", collectionName: reportedName };
        }
        if (resolved.collection !== sourceCollection) {
          // Bounded: resolved collection is always base name or alias target (never versioned),
          // so the stale check `sourceCollection !== reportedName` won't match on the second call.
          return this.getStatusFromCollection(resolved.collection, reportedName);
        }
        // No fallback found but collection has data — fall through to report stale_indexing.
      }

      return {
        isIndexed: false,
        status: isStale ? "stale_indexing" : "indexing",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        embeddingModel: marker.embeddingModel,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        enrichment,
      };
    }

    if (marker?.indexingComplete) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        filesCount: this.readFileCount(reportedName),
        embeddingModel: marker.embeddingModel,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        lastUpdated: marker.completedAt ? new Date(marker.completedAt) : undefined,
        enrichment,
        codegraphResolve: await this.readCodegraphResolve(sourceCollection),
        quarantine: await this.loadQuarantineSummary(reportedName),
      };
    }

    // Legacy collection (no marker) - check if it has content
    if (actualChunksCount > 0) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        filesCount: this.readFileCount(reportedName),
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        codegraphResolve: await this.readCodegraphResolve(sourceCollection),
      };
    }

    return {
      isIndexed: false,
      status: "not_indexed",
      collectionName: reportedName,
      chunksCount: 0,
      qdrantUrl: this.qdrant.url,
      sparseVersion,
    };
  }

  /**
   * Does the collection's indexing lock name a writer that is gone? The lock is
   * keyed by the logical name the run claimed. An unreadable lock proves
   * nothing, so it leaves the verdict to the heartbeat timer — a status call
   * never fails on it.
   */
  private async isWriterDead(reportedName: string): Promise<boolean> {
    if (!this.writerLiveness) return false;
    try {
      return (await this.writerLiveness.inspectLiveness(reportedName)) === "dead";
    } catch (error) {
      if (isDebug()) console.error(`[StatusModule] indexing lock of ${reportedName} unreadable:`, error);
      return false;
    }
  }

  /**
   * Resolve a stale versioned collection by finding a working fallback.
   * Deletes the stale collection and returns either a fallback collection name
   * or a notIndexed sentinel if no fallback exists.
   */
  private async resolveStaleCollection(
    staleCollection: string,
    reportedName: string,
    chunksCount: number,
  ): Promise<{ collection: string } | { notIndexed: true }> {
    // Versioned _vN with stale marker — check if a working version exists.
    const aliasTarget = await this.getAliasTarget(reportedName);
    if (aliasTarget) {
      // Alias points to a completed version — safe to delete stale _vN.
      await this.qdrant.deleteCollection(staleCollection);
      return { collection: aliasTarget };
    }
    // Legacy: no alias, but real collection may exist (pre-alias migration).
    const realExists = await this.qdrant.collectionExists(reportedName);
    if (realExists) {
      await this.qdrant.deleteCollection(staleCollection);
      return { collection: reportedName };
    }
    // No alias, no real collection (first index crashed). Delete only if empty.
    if (chunksCount === 0) {
      await this.qdrant.deleteCollection(staleCollection);
      return { notIndexed: true };
    }
    // Stale but has chunks and no fallback — keep it, caller reports stale_indexing.
    return { collection: staleCollection };
  }
}
