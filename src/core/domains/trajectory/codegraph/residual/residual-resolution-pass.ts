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
 * Accept thresholds come from `thresholdSource` (see `residual-thresholds.ts`):
 * a stored calibration valid for the run judges the asking and the edges alike;
 * a calibration fitted after the asking, from the run's own full-menu answers,
 * moves only what the asking did not branch on — none always, full menu unless
 * the confirm stage asked mid picks by the default — and block 1, which decides
 * early accept, waits for the next run.
 */

import { createHash } from "node:crypto";

import type { ResidualVerdictStore } from "../../../../adapters/duckdb/residual-verdict-store.js";
import {
  RESIDUAL_QUESTION_VERSION,
  RESIDUAL_STATE_BUILDER_VERSION,
  type ModelEdgeRow,
  type ModelExternalSiteRow,
  type ResidualAppliedThreshold,
  type ResidualCallSiteRow,
  type ResidualThresholdReport,
} from "../../../../contracts/types/codegraph-residual.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import { menuSizeBucket, type MenuSizeBucket } from "./calibration-answer.js";
import {
  DEFAULT_FANOUT_FLOOR,
  interfaceFanout,
  type InterfaceFanout,
  type ResidualClassTieReader,
} from "./interface-fanout.js";
import { collectReceiverGroups, GroupTournament, receiverClassQuestion } from "./receiver-group-tournament.js";
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
import type { ResidualAnswerMix, StratumFit } from "./residual-calibration-fit.js";
import { RESIDUAL_ORIGIN_CONTEXT_VERSION } from "./residual-origin-context.js";
import type {
  ResidualCalibratedThresholds,
  ResidualCalibrationKey,
  ResidualThresholdSource,
} from "./residual-thresholds.js";
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
  /** Reads the structural ties a fan-out needs; absent — no group fans out. */
  classTies?: ResidualClassTieReader;
  /** Smallest `p` of a class for it to join an interface fan-out; default {@link DEFAULT_FANOUT_FLOOR}. */
  fanoutFloor?: number;
  /** Recompute cycles and PageRank over the current graph; clears the derived-stale mark. */
  recomputeDerived: () => Promise<void>;
  /** Calibrated accept thresholds; absent — every stratum keeps its default. */
  thresholdSource?: ResidualThresholdSource;
}

/**
 * sha1 of the Kev prompt template the version-3 verdicts were asked under
 * (`KEV_PROMPT_TEMPLATE` when this fold was introduced). Never update it: a
 * template that no longer hashes to it re-keys every question, which is the
 * point.
 */
const RESIDUAL_V3_PROMPT_HASH = "35978f0544d30972eccbf7ede05b36ebaadd2d4b";

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** `originVersion` 0 = the origin-context variant is off. */
function foldOf(promptHash: string, stateBuilderVersion: number, originVersion: number): string {
  return sha1(`${promptHash}\u0000s${stateBuilderVersion}\u0000o${originVersion}`);
}

/** The fold of the version-3 question: its prompt, state builder 1, no origin context. Keys under it keep their version-3 form. */
export const RESIDUAL_V3_DEFAULT_FOLD = foldOf(RESIDUAL_V3_PROMPT_HASH, 1, 0);

/**
 * Hash of everything around the menu that shapes a question: the provider's
 * prompt template (absent = the version-3 one), {@link RESIDUAL_STATE_BUILDER_VERSION}
 * and, when on, the origin-context variant's {@link RESIDUAL_ORIGIN_CONTEXT_VERSION}.
 */
export function residualQuestionFold(parts: { promptTemplate?: string; originContext?: boolean }): string {
  const promptHash = parts.promptTemplate === undefined ? RESIDUAL_V3_PROMPT_HASH : sha1(parts.promptTemplate);
  return foldOf(
    promptHash,
    RESIDUAL_STATE_BUILDER_VERSION,
    parts.originContext === true ? RESIDUAL_ORIGIN_CONTEXT_VERSION : 0,
  );
}

/**
 * The verdict-store menu hash: the row's menu hash under
 * {@link RESIDUAL_QUESTION_VERSION} and the question `fold`. The default fold
 * keeps the version-3 key, so the verdicts cached before the fold stay valid.
 */
export function residualQuestionHash(menuHash: string, fold: string = RESIDUAL_V3_DEFAULT_FOLD): string {
  const key = `${menuHash}\u0000q${RESIDUAL_QUESTION_VERSION}`;
  return sha1(fold === RESIDUAL_V3_DEFAULT_FOLD ? key : `${key}\u0000f${fold}`);
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
    const servedVersion = input.mode === "ask" ? await servedModelVersion(provider) : { version: undefined };

    const fold = residualQuestionFold({
      ...(provider.promptTemplate === undefined ? {} : { promptTemplate: provider.promptTemplate }),
      originContext: input.originContext ?? false,
    });
    const questionHash = (menuHash: string): string => residualQuestionHash(menuHash, fold);
    const rows = await input.graphDb.readResidualCallSites();
    const { groups: receiverGroups, ungrouped } = collectReceiverGroups(rows);
    const eligibility = ungrouped.map((r) => siteEligibility(r, input));
    const eligible: EligibleSite[] = ungrouped
      .filter((_, i) => eligibility[i] === "eligible")
      .map((r) => ({ ...r, questionHash: questionHash(r.menuHash) }));
    const askable = receiverGroups.filter((g) => g.classes.length >= input.minMenu);
    const groupTooSmall = receiverGroups.filter((g) => g.classes.length < input.minMenu);
    const tournaments = askable.map((g) => new GroupTournament(g, input.menuLimit, questionHash, input.confirmStage));
    const defaults: Thresholds = {
      block1: input.namePriorAcceptThreshold ?? provider.threshold,
      fullMenu: provider.threshold,
      none: input.noneThreshold,
    };
    const { language, reason: noLanguage } = runLanguage(rows);
    const key: ResidualCalibrationKey = {
      providerId: provider.id,
      ...(servedVersion.version === undefined ? {} : { servedVersion: servedVersion.version }),
      templateHash: fold,
    };
    const stored = await storedThresholds(input.thresholdSource, language, key);
    const asking = stored.thresholds === undefined ? defaults : judged(stored.thresholds, defaults).values;
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
    const rounds = await new ResidualAskQueue(
      { ...input, namePriorAcceptThreshold: asking.block1, acceptThreshold: asking.fullMenu },
      servedVersion.version,
      verdicts,
      tally,
      tournaments,
    ).run(siteQuestions);
    const askedAt = input.now();

    const failureReason =
      tally.failures.length > 0 ? `${tally.failures.length} group(s) failed: ${tally.failures[0]}` : undefined;
    const unavailable = servedVersion.unavailable ?? rounds.notAcquired;
    const reason = unavailable ?? failureReason;
    const skipped = unavailable !== undefined || tally.leaseLost || tally.breakerTripped;

    const thresholds = await resolveThresholds({
      source: input.thresholdSource,
      stored,
      defaults,
      calibrable: input.mode === "ask" && !skipped,
      confirmStage: input.confirmStage === true,
      language,
      noLanguage,
      key,
      mix: () => runAnswerMix(tournaments, verdicts, questionHash),
      graphFingerprint: () => sha1([...rows.map((r) => r.siteKey)].sort().join("\n")),
    });
    const accept = thresholds.values;
    const siteOutcome = buildEdges(eligible, verdicts, provider, accept.fullMenu, accept.none);
    const acceptOf = (t: GroupTournament): number => (t.pickedByNamePrior ? accept.block1 : accept.fullMenu);
    const fanouts = await groupFanouts(tournaments, input, accept);
    const groupOutcome = buildGroupEdges(tournaments, provider, acceptOf, accept.none, fanouts);
    const propagation = propagateTypeFacts(
      receiverGroups,
      acceptedGroupVerdicts(tournaments, acceptOf, accept.none, fanouts),
      provider.id,
    );
    const edges = [...siteOutcome.edges, ...groupOutcome.edges, ...propagation.edges];
    const external = [...siteOutcome.external, ...groupOutcome.external];
    const attributes = [...groupOutcome.attributes, ...propagation.attributes];
    const belowThreshold = siteOutcome.belowThreshold + groupOutcome.belowThreshold;
    const applied = await input.graphDb.applyModelEdges(provider.id, edges);
    await input.graphDb.applyModelExternalSites(provider.id, [...external, ...attributes, ...propagation.externals]);
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
      sitesEdged: distinctSites(edges),
      receiverGroups: tournaments.length,
      receiverGroupSites: tournaments.reduce((n, t) => n + t.group.rows.length, 0),
      sitesEdgedByVerdict: distinctSites(groupOutcome.edges),
      fanoutGroups: fanouts.size,
      fanoutEdges: edges.filter((e) => (e.fanout ?? 0) >= 2).length,
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
      attributeByModel: attributes.length,
      externalByPropagation: propagation.externals.length,
      edgesApplied: applied.stored,
      derived,
      thresholds: thresholds.report,
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
}

/** The model version to ask under, or why the provider cannot be asked. */
export async function servedModelVersion(
  provider: ResidualModelProvider,
): Promise<{ version?: string; unavailable?: string }> {
  const unavailable = (detail: string) => ({ unavailable: `provider ${provider.id} unavailable: ${detail}` });
  try {
    const health = await provider.health();
    if (!health.ok) return unavailable(health.reason);
    return { version: await provider.version() };
  } catch (error) {
    return unavailable(describeError(error));
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

const distinctSites = (edges: readonly ModelEdgeRow[]): number => new Set(edges.map((e) => e.siteKey)).size;

/**
 * The groups whose answer fans out over one interface (see `interface-fanout.ts`),
 * judged by the threshold of the answer's own question. A none accepted as
 * external never fans out.
 */
async function groupFanouts(
  tournaments: readonly GroupTournament[],
  input: Pick<ResidualPassInput, "classTies" | "fanoutFloor">,
  thresholds: Thresholds,
): Promise<Map<GroupTournament, InterfaceFanout>> {
  const fanouts = new Map<GroupTournament, InterfaceFanout>();
  const { classTies } = input;
  if (classTies === undefined) return fanouts;
  const floor = input.fanoutFloor ?? DEFAULT_FANOUT_FLOOR;
  for (const tournament of tournaments) {
    const { spread, outcome } = tournament;
    if (spread === undefined) continue;
    if (outcome !== undefined && outcome !== "residual" && outcome.pick === null && outcome.p >= thresholds.none) {
      continue;
    }
    const likely = spread.menu.filter((cls) => (spread.probabilities[cls] ?? 0) >= floor);
    if (likely.length < 2) continue;
    const fanout = interfaceFanout({
      receiverText: tournament.group.receiverText,
      menu: spread.menu,
      probabilities: spread.probabilities,
      ties: await classTies.tiesOf(likely),
      floor,
      accept: spread.fromPrior ? thresholds.block1 : thresholds.fullMenu,
    });
    if (fanout !== undefined) fanouts.set(tournament, fanout);
  }
  return fanouts;
}

/**
 * A fanned-out group types the next chain hop only when every fanned class
 * returns the same class on every site; the verdict then names the first of them.
 */
function fanoutVerdict(tournament: GroupTournament, fanout: InterfaceFanout): AcceptedGroupVerdict | undefined {
  for (const row of tournament.group.rows) {
    const returns = new Set(fanout.classes.map((cls) => row.classTargets?.find(([c]) => c === cls)?.[2]));
    if (returns.size !== 1 || returns.has(undefined)) return undefined;
  }
  return { pick: fanout.classes[0], p: fanout.p };
}

/**
 * Every group's verdict at or above its threshold — `acceptOf` for a class,
 * `noneThreshold` for none; a fanned-out group's per {@link fanoutVerdict}.
 */
function acceptedGroupVerdicts(
  tournaments: readonly GroupTournament[],
  acceptOf: (tournament: GroupTournament) => number,
  noneThreshold: number,
  fanouts: ReadonlyMap<GroupTournament, InterfaceFanout>,
): Map<string, AcceptedGroupVerdict> {
  const accepted = new Map<string, AcceptedGroupVerdict>();
  for (const tournament of tournaments) {
    const { group, outcome } = tournament;
    const fanout = fanouts.get(tournament);
    if (fanout !== undefined) {
      const verdict = fanoutVerdict(tournament, fanout);
      if (verdict !== undefined) accepted.set(receiverGroupAddress(group), verdict);
      continue;
    }
    if (outcome === undefined || outcome === "residual") continue;
    if (outcome.p < (outcome.pick === null ? noneThreshold : acceptOf(tournament))) continue;
    accepted.set(receiverGroupAddress(group), outcome);
  }
  return accepted;
}

/**
 * Edges and external sites of the groups that reached a verdict: a class at or
 * above its accept threshold (`acceptOf`) edges every site of the group to the target its
 * member reaches on that class, or makes it an attribute where the class reads
 * the member as a schema column; a none at or above `noneThreshold` makes every
 * site external. A fanned-out group replaces its class verdict: see {@link fanoutSiteEdges}.
 */
function buildGroupEdges(
  tournaments: readonly GroupTournament[],
  provider: ResidualModelProvider,
  acceptOf: (tournament: GroupTournament) => number,
  noneThreshold: number,
  fanouts: ReadonlyMap<GroupTournament, InterfaceFanout>,
): {
  edges: ModelEdgeRow[];
  external: ModelExternalSiteRow[];
  attributes: ModelExternalSiteRow[];
  belowThreshold: number;
} {
  const edges: ModelEdgeRow[] = [];
  const external: ModelExternalSiteRow[] = [];
  const attributes: ModelExternalSiteRow[] = [];
  let belowThreshold = 0;
  for (const tournament of tournaments) {
    const { group, outcome } = tournament;
    const fanout = fanouts.get(tournament);
    if (fanout !== undefined) {
      for (const r of group.rows) {
        const site = fanoutSiteEdges(r, fanout, provider.id);
        if (site === "attribute") {
          attributes.push({ ...siteRef(r), model: provider.id, p: fanout.p, outcome: "attribute" });
        } else if (site.length === 0) belowThreshold++;
        else edges.push(...site);
      }
      continue;
    }
    if (outcome === undefined || outcome === "residual") continue;
    const { pick, p } = outcome;
    if (pick === null ? p < noneThreshold : p < acceptOf(tournament)) {
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
      const entry = r.classTargets?.find(([cls]) => cls === pick);
      if (entry === undefined) {
        belowThreshold++;
        continue;
      }
      const target = entry[1];
      if (target === null) {
        attributes.push({
          siteKey: r.siteKey,
          sourceRelPath: r.sourceRelPath,
          menuHash: r.menuHash,
          model: provider.id,
          p,
          outcome: "attribute",
        });
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
  return { edges, external, attributes, belowThreshold };
}

const siteRef = (r: ResidualCallSiteRow) => ({
  siteKey: r.siteKey,
  sourceRelPath: r.sourceRelPath,
  menuHash: r.menuHash,
});

/**
 * One site's edges under a fan-out: one per distinct target the fanned classes
 * reach the member through, each with the summed `p`, marked with the target
 * count when it is two or more. Every fanned class reading the member as a
 * schema column makes the site an attribute; no fanned class on the row, no edge.
 */
function fanoutSiteEdges(r: ResidualCallSiteRow, fanout: InterfaceFanout, model: string): ModelEdgeRow[] | "attribute" {
  const entries = fanout.classes
    .map((cls) => r.classTargets?.find(([c]) => c === cls))
    .filter((entry) => entry !== undefined);
  const targets = [...new Set(entries.flatMap(([, target]) => (target === null ? [] : [target])))];
  if (targets.length === 0) return entries.length > 0 ? "attribute" : [];
  return targets.map((targetSymbolId) => ({
    siteKey: r.siteKey,
    sourceRelPath: r.sourceRelPath,
    sourceSymbolId: r.methodSymbolId,
    targetSymbolId,
    model,
    p: fanout.p,
    ...(targets.length > 1 ? { fanout: targets.length } : {}),
  }));
}

/** A pick at or above `accept` is an edge; a none at or above `noneThreshold` an external site. */
function buildEdges(
  rows: EligibleSite[],
  verdicts: Map<string, ResidualVerdict>,
  provider: ResidualModelProvider,
  accept: number,
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
    if (verdict.p < accept || !r.candidates.includes(verdict.pick)) {
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

/** The accept threshold of each stratum. */
interface Thresholds {
  block1: number;
  fullMenu: number;
  none: number;
}

type Stratum = keyof Thresholds;

const STRATA: readonly Stratum[] = ["block1", "fullMenu", "none"];

/** The one language of the run's residual sites — a calibration is per language — or why there is none. */
function runLanguage(rows: readonly ResidualCallSiteRow[]): { language?: string; reason?: string } {
  const languages = [...new Set(rows.flatMap((r) => (r.language === undefined ? [] : [r.language])))];
  if (languages.length === 1) return { language: languages[0] };
  if (languages.length === 0) return { reason: "no language on the residual sites" };
  return { reason: `${languages.length} languages in one run (${languages.sort().join(", ")})` };
}

/** The stored calibration valid for the run, or why none is read. A read failure never fails the pass. */
async function storedThresholds(
  source: ResidualThresholdSource | undefined,
  language: string | undefined,
  key: ResidualCalibrationKey,
): Promise<{ thresholds?: ResidualCalibratedThresholds; reason?: string }> {
  if (source === undefined || language === undefined) return {};
  try {
    const thresholds = await source.stored(language, key);
    return thresholds === undefined ? {} : { thresholds };
  } catch (error) {
    return { reason: `stored calibration unreadable: ${describeError(error)}` };
  }
}

/** Each stratum's calibrated cut where `fits` has one (`only` limits which), else its default. */
function judged(
  fits: ResidualCalibratedThresholds,
  defaults: Thresholds,
  only: readonly Stratum[] = STRATA,
): { values: Thresholds; report: ResidualThresholdReport } {
  const one = (stratum: Stratum): ResidualAppliedThreshold => {
    const fit: StratumFit | null = only.includes(stratum) ? fits[stratum] : null;
    return fit === null
      ? { threshold: defaults[stratum], source: "default" }
      : { threshold: fit.threshold, source: "calibrated", lowerBound: fit.lowerBound, n: fit.n };
  };
  const report: ResidualThresholdReport = {
    block1: one("block1"),
    fullMenu: one("fullMenu"),
    none: one("none"),
    pi: fits.pi,
  };
  return { values: valuesOf(report), report };
}

function valuesOf(report: ResidualThresholdReport): Thresholds {
  return { block1: report.block1.threshold, fullMenu: report.fullMenu.threshold, none: report.none.threshold };
}

function defaultThresholds(
  defaults: Thresholds,
  reason?: string,
): { values: Thresholds; report: ResidualThresholdReport } {
  const one = (stratum: Stratum): ResidualAppliedThreshold => ({ threshold: defaults[stratum], source: "default" });
  return {
    values: defaults,
    report: {
      block1: one("block1"),
      fullMenu: one("fullMenu"),
      none: one("none"),
      pi: null,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

/**
 * The thresholds the edges are built with. A stored calibration applies whole —
 * the asking already ran under it. Otherwise a calibration fitted now applies
 * only where the asking did not branch on the threshold: none always; full menu
 * unless the confirm stage sent mid picks to a confirm by the default; block 1
 * never — it decided early accept — so its fit waits for the next run.
 */
async function resolveThresholds(run: {
  source: ResidualThresholdSource | undefined;
  stored: { thresholds?: ResidualCalibratedThresholds; reason?: string };
  defaults: Thresholds;
  calibrable: boolean;
  confirmStage: boolean;
  language: string | undefined;
  noLanguage: string | undefined;
  key: ResidualCalibrationKey;
  mix: () => ResidualAnswerMix;
  graphFingerprint: () => string;
}): Promise<{ values: Thresholds; report: ResidualThresholdReport }> {
  const { source, stored, defaults } = run;
  if (stored.thresholds !== undefined) return judged(stored.thresholds, defaults);
  if (source === undefined) return defaultThresholds(defaults);
  if (stored.reason !== undefined) return defaultThresholds(defaults, stored.reason);
  if (run.language === undefined) return defaultThresholds(defaults, `not calibrated: ${run.noLanguage}`);
  if (source.calibrate === undefined || !run.calibrable) return defaultThresholds(defaults);
  let fits: ResidualCalibratedThresholds;
  try {
    fits = await source.calibrate({
      language: run.language,
      key: run.key,
      mix: run.mix(),
      graphFingerprint: run.graphFingerprint(),
    });
  } catch (error) {
    return defaultThresholds(defaults, `calibration failed: ${describeError(error)}`);
  }
  const deferred: string[] = [];
  if (fits.block1 !== null) {
    deferred.push(`block 1 fit ${fits.block1.threshold.toFixed(2)} decides early accept while asking`);
  }
  if (fits.fullMenu !== null && run.confirmStage) {
    deferred.push(`full-menu fit ${fits.fullMenu.threshold.toFixed(2)} decides the confirm stage while asking`);
  }
  const applied = judged(fits, defaults, run.confirmStage ? ["none"] : ["fullMenu", "none"]);
  if (deferred.length === 0) return applied;
  return { ...applied, report: { ...applied.report, reason: `applies from the next run: ${deferred.join("; ")}` } };
}

/**
 * The run's own full-menu answers — the receiver groups asked one question over
 * their whole class set — as the calibration fit reads them: how many, how many
 * none, and their menu sizes.
 */
function runAnswerMix(
  tournaments: readonly GroupTournament[],
  verdicts: ReadonlyMap<string, ResidualVerdict>,
  questionHash: (menuHash: string) => string,
): ResidualAnswerMix {
  let answered = 0;
  let noneAnswers = 0;
  const menuSizeMix: Partial<Record<MenuSizeBucket, number>> = {};
  for (const tournament of tournaments) {
    if (tournament.isTournament) continue;
    const { group } = tournament;
    const question = receiverClassQuestion(group, group.classes, group.id, questionHash);
    const verdict = verdicts.get(verdictKey(question.siteKey, question.menuHash));
    if (verdict === undefined) continue;
    answered++;
    if (verdict.pick === null) noneAnswers++;
    const bucket = menuSizeBucket(group.classes.length);
    menuSizeMix[bucket] = (menuSizeMix[bucket] ?? 0) + 1;
  }
  return { answered, noneAnswers, menuSizeMix };
}
