/**
 * Asks a residual model about the call sites the static resolver left open,
 * caches every verdict, and applies the confident ones as `origin: "model"`
 * edges. Every run applies the FULL model edge set of the current sites —
 * `applyModelEdges` replaces the model's edges, and a static re-walk of a file
 * drops that file's model edges. A provider that is down or keeps failing ends
 * the pass `skipped`, cancelling the asks still in flight; the verdicts already
 * held are applied all the same. Asking — capped requests, one shared queue,
 * no round barrier — lives in `residual-ask-queue.ts`. Only eligible sites (see
 * {@link siteEligibility}) are asked or applied. The pass runs after finalize,
 * so when the applied edges change it recomputes the derived metrics itself,
 * best-effort.
 * A provider that leases its hardware (`acquire`) is leased only when some
 * site needs asking, and released however the asking ends.
 * A "none of these" verdict at or above `noneThreshold` makes no edge: the site
 * is stored as external (`applyModelExternalSites`), out of the recall denominator.
 * Sites carrying a receiver group are asked once per group over its class set
 * (see `receiver-group-tournament.ts`); a tournament's next round is built from
 * the previous one's verdicts as soon as that round is answered.
 */

import { createHash } from "node:crypto";

import type { ResidualVerdictStore } from "../../../../adapters/duckdb/residual-verdict-store.js";
import {
  RESIDUAL_QUESTION_VERSION,
  type ModelEdgeRow,
  type ModelExternalSiteRow,
  type ResidualCallSiteRow,
} from "../../../../contracts/types/codegraph-residual.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import { collectReceiverGroups, GroupTournament } from "./receiver-group-tournament.js";
import {
  cachedVerdicts,
  describeError,
  emptyTally,
  percentile,
  ResidualAskQueue,
  verdictKey,
  type AskQueueInput,
  type PendingQuestion,
} from "./residual-ask-queue.js";
import { propagateTypeFacts, receiverGroupAddress, type AcceptedGroupVerdict } from "./type-fact-propagation.js";
import type {
  ResidualDerivedState,
  ResidualModelProvider,
  ResidualPassMode,
  ResidualPassReport,
  ResidualVerdict,
} from "./types.js";

export {
  DEFAULT_MAX_CONSECUTIVE_GROUP_FAILURES,
  DEFAULT_MAX_CRITERIA_PER_REQUEST,
  DEFAULT_MAX_GROUP_FAILURE_RATE,
  DEFAULT_MAX_GROUP_FAILURES,
  DEFAULT_MAX_QUESTIONS_PER_REQUEST,
} from "./residual-ask-queue.js";

export interface ResidualPassInput extends AskQueueInput {
  graphDb: Pick<
    GraphDbClient,
    "readResidualCallSites" | "applyModelEdges" | "applyModelExternalSites" | "markDerivedStale"
  >;
  store: Pick<ResidualVerdictStore, "find" | "findLatest" | "put" | "touch" | "expire">;
  mode: ResidualPassMode;
  menuLimit: number;
  /** Smallest menu a site needs to be asked or applied. */
  minMenu: number;
  /** Smallest `p` of a "none of these" verdict that counts its site as external. */
  noneThreshold: number;
  retentionDays: number;
  /** Recompute cycles and PageRank over the current graph; clears the derived-stale mark. */
  recomputeDerived: () => Promise<void>;
}

/** The verdict-store menu hash: the row's menu hash under {@link RESIDUAL_QUESTION_VERSION}. */
export function residualQuestionHash(menuHash: string): string {
  return createHash("sha1").update(`${menuHash}\u0000q${RESIDUAL_QUESTION_VERSION}`).digest("hex");
}

/** An eligible row and the menu hash its verdict is stored under. */
interface EligibleSite extends ResidualCallSiteRow {
  questionHash: string;
}

export type SiteEligibility = "eligible" | "menuOverflow" | "menuTooSmall";

/**
 * Whether the pass asks about and applies a site. A menu cut at the limit was
 * never measured; a menu under the floor rarely holds the true target, and the
 * model's probability, normalised over it, tends to 1.0 whatever the answer.
 */
export function siteEligibility(
  row: Pick<ResidualCallSiteRow, "menuOverflow" | "candidates">,
  limits: { menuLimit: number; minMenu: number },
): SiteEligibility {
  if (row.menuOverflow || row.candidates.length > limits.menuLimit) return "menuOverflow";
  if (row.candidates.length < limits.minMenu) return "menuTooSmall";
  return "eligible";
}

export class ResidualResolutionPass {
  async run(input: ResidualPassInput): Promise<ResidualPassReport> {
    const { provider } = input;
    const startedAt = input.now();
    const servedVersion = input.mode === "ask" ? await this.servedVersion(provider) : { version: undefined };

    const rows = await input.graphDb.readResidualCallSites();
    const { groups: receiverGroups, ungrouped } = collectReceiverGroups(rows);
    const eligibility = ungrouped.map((r) => siteEligibility(r, input));
    const eligible: EligibleSite[] = ungrouped
      .filter((_, i) => eligibility[i] === "eligible")
      .map((r) => ({ ...r, questionHash: residualQuestionHash(r.menuHash) }));
    const askable = receiverGroups.filter((g) => g.classes.length >= input.minMenu);
    const groupTooSmall = receiverGroups.filter((g) => g.classes.length < input.minMenu);
    const tournaments = askable.map(
      (g) => new GroupTournament(g, input.menuLimit, residualQuestionHash, input.confirmStage),
    );
    const verdicts = await cachedVerdicts(
      input,
      eligible.map((r) => ({ siteKey: r.siteKey, menuHash: r.questionHash })),
      servedVersion.version,
    );
    const cacheHits = eligible.filter((r) => verdicts.has(verdictKey(r.siteKey, r.questionHash))).length;
    const siteQuestions = eligible
      .filter((r) => !verdicts.has(verdictKey(r.siteKey, r.questionHash)))
      .map(siteQuestion);
    const readAt = input.now();

    const tally = emptyTally();
    const rounds = await new ResidualAskQueue(input, servedVersion.version, verdicts, tally, tournaments).run(
      siteQuestions,
    );
    const askedAt = input.now();

    const failureReason =
      tally.failures.length > 0 ? `${tally.failures.length} group(s) failed: ${tally.failures[0]}` : undefined;
    const unavailable = servedVersion.unavailable ?? rounds.notAcquired;
    const reason = unavailable ?? failureReason;
    const skipped = unavailable !== undefined || tally.leaseLost || tally.breakerTripped;

    const siteOutcome = buildEdges(eligible, verdicts, provider, input.noneThreshold);
    const groupOutcome = buildGroupEdges(tournaments, provider, input.noneThreshold);
    const propagation = propagateTypeFacts(
      receiverGroups,
      acceptedGroupVerdicts(tournaments, provider, input.noneThreshold),
      provider.id,
    );
    const edges = [...siteOutcome.edges, ...groupOutcome.edges, ...propagation.edges];
    const external = [...siteOutcome.external, ...groupOutcome.external];
    const belowThreshold = siteOutcome.belowThreshold + groupOutcome.belowThreshold;
    const applied = await input.graphDb.applyModelEdges(provider.id, edges);
    await input.graphDb.applyModelExternalSites(provider.id, external);
    const recomputeStartedAt = input.now();
    const derived = applied.changed ? await this.recomputeDerived(input) : "unchanged";
    const recomputeMs = input.now() - recomputeStartedAt;
    await input.store.touch([...rows.map((r) => r.siteKey), ...rounds.questionKeys], provider.id, input.now());
    await input.store.expire(input.retentionDays, input.now());
    const finishedAt = input.now();

    return {
      outcome: skipped ? "skipped" : "completed",
      ...(reason !== undefined ? { reason } : {}),
      mode: input.mode,
      sites: rows.length,
      menuOverflow: eligibility.filter((e) => e === "menuOverflow").length,
      menuTooSmall:
        eligibility.filter((e) => e === "menuTooSmall").length + groupTooSmall.reduce((n, g) => n + g.rows.length, 0),
      cacheHits,
      groupCacheHits: tally.groupCacheHits,
      groups: tally.batches,
      asked: tally.asked,
      answered: tally.answered,
      tooLong: tally.tooLong,
      failedGroups: tally.failures.length,
      abortedGroups: tally.aborted,
      requeuedGroups: tally.requeued,
      belowThreshold,
      sitesEdged: edges.length,
      receiverGroups: tournaments.length,
      receiverGroupSites: tournaments.reduce((n, t) => n + t.group.rows.length, 0),
      sitesEdgedByVerdict: groupOutcome.edges.length,
      sitesEdgedByPropagation: propagation.edges.length,
      propagationConflicts: propagation.conflicts,
      tournamentGroups: tournaments.filter((t) => t.isTournament).length,
      tournamentRounds: Math.max(0, ...tournaments.filter((t) => t.isTournament).map((t) => t.round)),
      tournamentQuestions: rounds.tournamentQuestions,
      namePriorGroups: tournaments.filter((t) => t.hasNamePrior).length,
      earlyAcceptedGroups: tournaments.filter((t) => t.earlyAccepted).length,
      groupsSkippedByBudget: rounds.skippedByBudget,
      confirmQuestions: tournaments.filter((t) => t.confirmAnswered).length,
      confirmAccepted: tournaments.filter((t) => t.confirmAccepted).length,
      windowedGroups: tally.windowed,
      requests: tally.requests,
      maxQuestionsPerRequest: tally.maxQuestionsPerRequest,
      requestLatencyP50Ms: percentile(tally.latenciesMs, 0.5),
      requestLatencyP95Ms: percentile(tally.latenciesMs, 0.95),
      peakInFlight: tally.peakInFlight,
      externalByModel: external.length,
      edgesApplied: applied.stored,
      derived,
      durations: {
        readMs: readAt - startedAt,
        askMs: askedAt - readAt,
        applyMs: finishedAt - askedAt,
        recomputeMs,
        totalMs: finishedAt - startedAt,
      },
    };
  }

  /**
   * Mark the derived tables stale, then recompute them; a failed recompute
   * leaves the mark for the next run and never fails the pass.
   */
  private async recomputeDerived(input: ResidualPassInput): Promise<ResidualDerivedState> {
    await input.graphDb.markDerivedStale();
    try {
      await input.recomputeDerived();
      return "recomputed";
    } catch (error) {
      console.error(`[Residual] derived metrics recompute failed, left stale: ${describeError(error)}`);
      return "stale";
    }
  }

  /** The model version to ask under, or why the provider cannot be asked. */
  private async servedVersion(provider: ResidualModelProvider): Promise<{ version?: string; unavailable?: string }> {
    const unavailable = (detail: string) => ({ unavailable: `provider ${provider.id} unavailable: ${detail}` });
    try {
      const health = await provider.health();
      if (!health.ok) return unavailable(health.reason);
      return { version: await provider.version() };
    } catch (error) {
      return unavailable(describeError(error));
    }
  }
}

/** A site's own question, in its method. */
function siteQuestion(r: EligibleSite): PendingQuestion {
  return {
    sourceRelPath: r.sourceRelPath,
    methodSymbolId: r.methodSymbolId,
    methodStartLine: r.methodStartLine,
    methodEndLine: r.methodEndLine,
    lines: [r.line],
    question: {
      siteKey: r.siteKey,
      menuHash: r.questionHash,
      receiverText: r.receiverText,
      member: r.member,
      kind: r.kind,
      candidates: r.candidates,
    },
  };
}

/** Every group's verdict at or above its threshold — the provider's for a class, `noneThreshold` for none. */
function acceptedGroupVerdicts(
  tournaments: readonly GroupTournament[],
  provider: ResidualModelProvider,
  noneThreshold: number,
): Map<string, AcceptedGroupVerdict> {
  const accepted = new Map<string, AcceptedGroupVerdict>();
  for (const { group, outcome } of tournaments) {
    if (outcome === undefined || outcome === "residual") continue;
    if (outcome.p < (outcome.pick === null ? noneThreshold : provider.threshold)) continue;
    accepted.set(receiverGroupAddress(group), outcome);
  }
  return accepted;
}

/**
 * Edges and external sites of the groups that reached a verdict: a class at or
 * above the provider threshold edges every site of the group to the target its
 * member reaches on that class; a none at or above `noneThreshold` makes every
 * site external.
 */
function buildGroupEdges(
  tournaments: readonly GroupTournament[],
  provider: ResidualModelProvider,
  noneThreshold: number,
): { edges: ModelEdgeRow[]; external: ModelExternalSiteRow[]; belowThreshold: number } {
  const edges: ModelEdgeRow[] = [];
  const external: ModelExternalSiteRow[] = [];
  let belowThreshold = 0;
  for (const { group, outcome } of tournaments) {
    if (outcome === undefined || outcome === "residual") continue;
    const { pick, p } = outcome;
    if (pick === null ? p < noneThreshold : p < provider.threshold) {
      belowThreshold += group.rows.length;
      continue;
    }
    for (const r of group.rows) {
      if (pick === null) {
        external.push({
          siteKey: r.siteKey,
          sourceRelPath: r.sourceRelPath,
          menuHash: r.menuHash,
          model: provider.id,
          p,
        });
        continue;
      }
      const target = r.classTargets?.find(([cls]) => cls === pick)?.[1];
      if (target === undefined) {
        belowThreshold++;
        continue;
      }
      edges.push({
        siteKey: r.siteKey,
        sourceRelPath: r.sourceRelPath,
        sourceSymbolId: r.methodSymbolId,
        targetSymbolId: target,
        model: provider.id,
        p,
      });
    }
  }
  return { edges, external, belowThreshold };
}

/** A pick at or above the provider threshold is an edge; a none at or above `noneThreshold` an external site. */
function buildEdges(
  rows: EligibleSite[],
  verdicts: Map<string, ResidualVerdict>,
  provider: ResidualModelProvider,
  noneThreshold: number,
): { edges: ModelEdgeRow[]; external: ModelExternalSiteRow[]; belowThreshold: number } {
  const edges: ModelEdgeRow[] = [];
  const external: ModelExternalSiteRow[] = [];
  const emitted = new Set<string>();
  let belowThreshold = 0;
  for (const r of rows) {
    const key = verdictKey(r.siteKey, r.questionHash);
    const verdict = verdicts.get(key);
    if (!verdict || emitted.has(key)) continue;
    emitted.add(key);
    if (verdict.pick === null) {
      if (verdict.p < noneThreshold) {
        belowThreshold++;
        continue;
      }
      external.push({
        siteKey: r.siteKey,
        sourceRelPath: r.sourceRelPath,
        menuHash: r.menuHash,
        model: provider.id,
        p: verdict.p,
      });
      continue;
    }
    if (verdict.p < provider.threshold || !r.candidates.includes(verdict.pick)) {
      belowThreshold++;
      continue;
    }
    edges.push({
      siteKey: r.siteKey,
      sourceRelPath: r.sourceRelPath,
      sourceSymbolId: r.methodSymbolId,
      targetSymbolId: verdict.pick,
      model: provider.id,
      p: verdict.p,
    });
  }
  return { edges, external, belowThreshold };
}
