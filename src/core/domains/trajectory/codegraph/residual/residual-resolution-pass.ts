/**
 * Asks a residual model about the call sites the static resolver left open,
 * caches every verdict, and applies the confident ones as `origin: "model"`
 * edges. Every run applies the FULL model edge set of the current sites —
 * `applyModelEdges` replaces the model's edges, and a static re-walk of a file
 * drops that file's model edges. A provider that is down or keeps failing ends
 * the pass `skipped`, cancelling the asks still in flight; the verdicts already
 * held are applied all the same. A group that timed out is asked once more at
 * the tail of the queue, since it usually only waited behind a slow batch. Only eligible sites (see
 * {@link siteEligibility}) are asked or applied. The pass runs after finalize,
 * so when the applied edges change it recomputes the derived metrics itself,
 * best-effort.
 * A provider that leases its hardware (`acquire`) is leased only when some
 * site needs asking, and released however the asking ends.
 * A "none of these" verdict at or above `noneThreshold` makes no edge: the site
 * is stored as external (`applyModelExternalSites`), out of the recall denominator.
 * Sites carrying a receiver group are asked once per group over its class set
 * (see `receiver-group-tournament.ts`); asking runs in rounds, the tournament's
 * next round built from the previous one's verdicts. A method refused as too
 * long is asked once more over a window around its call lines.
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
import type { ProgressCallback } from "../../../../types.js";
import {
  collectReceiverGroups,
  DEFAULT_TOURNAMENT_BUDGET,
  DEFAULT_TOURNAMENT_FLOOR,
  GroupTournament,
  MAX_TOURNAMENT_ROUNDS,
  windowMethodSource,
} from "./receiver-group-tournament.js";
import type {
  ResidualAnswer,
  ResidualDerivedState,
  ResidualModelProvider,
  ResidualPassMode,
  ResidualPassReport,
  ResidualProviderLease,
  ResidualQuestion,
  ResidualVerdict,
} from "./types.js";

export const DEFAULT_MAX_GROUP_FAILURES = 3;
export const DEFAULT_MAX_GROUP_FAILURE_RATE = 0.02;
export const DEFAULT_MAX_CONSECUTIVE_GROUP_FAILURES = 5;

/** Provider error codes for a group that may answer when asked again later; it is requeued once. */
const REQUEUE_CODES = new Set(["INFRA_KEV_TIMEOUT"]);

/** Provider error codes that mean "this method source is too long to ask"; its sites are skipped, not failed. */
const STATE_TOO_LONG_CODES = new Set(["INFRA_KEV_STATE_TOO_LONG"]);

/** Provider error codes that mean the hardware lease is gone; no further group can be answered. */
const LEASE_LOST_CODES = new Set(["INFRA_KEV_SESSION_LOST"]);

export interface ResidualPassInput {
  graphDb: Pick<
    GraphDbClient,
    "readResidualCallSites" | "applyModelEdges" | "applyModelExternalSites" | "markDerivedStale"
  >;
  store: Pick<ResidualVerdictStore, "find" | "findLatest" | "put" | "touch" | "expire">;
  provider: ResidualModelProvider;
  mode: ResidualPassMode;
  /** Method groups in flight at once. */
  concurrency: number;
  menuLimit: number;
  /** Smallest menu a site needs to be asked or applied. */
  minMenu: number;
  /** Smallest `p` of a "none of these" verdict that counts its site as external. */
  noneThreshold: number;
  retentionDays: number;
  /** Recompute cycles and PageRank over the current graph; clears the derived-stale mark. */
  recomputeDerived: () => Promise<void>;
  readMethodSource: (relPath: string, startLine: number, endLine: number) => Promise<string>;
  /** Epoch ms. */
  now: () => number;
  onProgress?: ProgressCallback;
  /** Failed groups tolerated however few groups the pass has; the budget is the larger of this and the rate. */
  maxGroupFailures?: number;
  /** Failed groups tolerated as a share of the pass's groups, e.g. 0.02. */
  maxGroupFailureRate?: number;
  /** Failed groups in a row (in completion order) that trip the breaker whatever the budget. */
  maxConsecutiveGroupFailures?: number;
  /** Smallest `p` of a tournament block winner that enters the next round. */
  tournamentFloor?: number;
  /** Tournament block questions this run may send; a group that would exceed it is skipped. */
  tournamentBudget?: number;
}

interface PendingGroup {
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  /** Call lines of the questions, for the window a too-long method is asked over. */
  lines: number[];
  questions: ResidualQuestion[];
}

/** A question and the method it is asked in. */
interface PendingQuestion {
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  lines: readonly number[];
  question: ResidualQuestion;
}

interface AskTally {
  asked: number;
  answered: number;
  tooLong: number;
  failures: string[];
  /** Groups cancelled in flight when the pass stopped asking. */
  aborted: number;
  /** Groups asked again at the tail after a timeout. */
  requeued: number;
  /** Failed groups in a row; an answered group restarts it. */
  consecutiveFailures: number;
  leaseLost: boolean;
  /** The failure budget or the consecutive-failure limit was exceeded. */
  breakerTripped: boolean;
  /** Method batches refused as too long and asked again over a window. */
  windowed: number;
  /** Method batches with an uncached question, over every round. */
  batches: number;
}

const verdictKey = (siteKey: string, menuHash: string): string => `${siteKey}\u0000${menuHash}`;

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
    const tournaments = askable.map((g) => new GroupTournament(g, input.menuLimit, residualQuestionHash));
    const verdicts = await this.cachedVerdicts(
      input,
      eligible.map((r) => ({ siteKey: r.siteKey, menuHash: r.questionHash })),
      servedVersion.version,
    );
    const cacheHits = eligible.filter((r) => verdicts.has(verdictKey(r.siteKey, r.questionHash))).length;
    const siteQuestions = eligible
      .filter((r) => !verdicts.has(verdictKey(r.siteKey, r.questionHash)))
      .map(siteQuestion);
    const readAt = input.now();

    const tally: AskTally = {
      asked: 0,
      answered: 0,
      tooLong: 0,
      failures: [],
      aborted: 0,
      requeued: 0,
      consecutiveFailures: 0,
      leaseLost: false,
      breakerTripped: false,
      windowed: 0,
      batches: 0,
    };
    const rounds = await this.askRounds(siteQuestions, tournaments, servedVersion.version, verdicts, tally, input);
    const askedAt = input.now();

    const failureReason =
      tally.failures.length > 0 ? `${tally.failures.length} group(s) failed: ${tally.failures[0]}` : undefined;
    const unavailable = servedVersion.unavailable ?? rounds.notAcquired;
    const reason = unavailable ?? failureReason;
    const skipped = unavailable !== undefined || tally.leaseLost || tally.breakerTripped;

    const siteOutcome = buildEdges(eligible, verdicts, provider, input.noneThreshold);
    const groupOutcome = buildGroupEdges(tournaments, provider, input.noneThreshold);
    const edges = [...siteOutcome.edges, ...groupOutcome.edges];
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
      sitesEdgedByPropagation: 0,
      tournamentGroups: tournaments.filter((t) => t.isTournament).length,
      tournamentRounds: Math.max(0, ...tournaments.filter((t) => t.isTournament).map((t) => t.round)),
      tournamentQuestions: rounds.tournamentQuestions,
      groupsSkippedByBudget: rounds.skippedByBudget,
      windowedGroups: tally.windowed,
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

  /**
   * Asks round by round: the site questions and every group's first round, then
   * each tournament's next round from the verdicts the previous one left. The
   * provider's lease is taken on the first round with an uncached question and
   * held until the last; a tournament whose uncached block questions exceed the
   * remaining budget is abandoned and counted.
   */
  private async askRounds(
    siteQuestions: PendingQuestion[],
    tournaments: GroupTournament[],
    modelVersion: string | undefined,
    verdicts: Map<string, ResidualVerdict>,
    tally: AskTally,
    input: ResidualPassInput,
  ): Promise<{ questionKeys: string[]; tournamentQuestions: number; skippedByBudget: number; notAcquired?: string }> {
    const floor = input.tournamentFloor ?? DEFAULT_TOURNAMENT_FLOOR;
    let budget = input.tournamentBudget ?? DEFAULT_TOURNAMENT_BUDGET;
    const questionKeys: string[] = [];
    let tournamentQuestions = 0;
    let skippedByBudget = 0;
    let lease: ResidualProviderLease | undefined;
    let notAcquired: string | undefined;
    const canAsk = () =>
      modelVersion !== undefined && notAcquired === undefined && !tally.leaseLost && !tally.breakerTripped;
    try {
      for (let round = 1; round <= MAX_TOURNAMENT_ROUNDS; round++) {
        const asking = tournaments
          .filter((t) => t.outcome === undefined)
          .map((t) => ({ tournament: t, questions: t.questions() }))
          .filter((a) => a.questions.length > 0);
        const keys = asking.flatMap((a) => a.questions.map((q) => ({ siteKey: q.siteKey, menuHash: q.menuHash })));
        questionKeys.push(...keys.map((k) => k.siteKey));
        for (const [key, verdict] of await this.cachedVerdicts(input, keys, modelVersion)) verdicts.set(key, verdict);
        const pending = round === 1 ? [...siteQuestions] : [];
        for (const { tournament, questions } of asking) {
          const uncached = questions.filter((q) => !verdicts.has(verdictKey(q.siteKey, q.menuHash)));
          if (uncached.length === 0) continue;
          if (tournament.isTournament && canAsk()) {
            if (uncached.length > budget) {
              tournament.abandon();
              skippedByBudget++;
              continue;
            }
            budget -= uncached.length;
            tournamentQuestions += uncached.length;
          }
          pending.push(...uncached.map((question) => groupQuestion(tournament, question)));
        }
        const batches = batchQuestions(pending);
        tally.batches += batches.length;
        if (batches.length > 0 && canAsk()) {
          if (lease === undefined && input.provider.acquire) {
            const taken = await this.acquireLease(input, batches.length);
            if (typeof taken === "string") notAcquired = taken;
            else lease = taken;
          }
          if (notAcquired === undefined) await this.askGroups(batches, modelVersion as string, verdicts, tally, input);
        }
        for (const { tournament } of asking) {
          tournament.advance((q) => verdicts.get(verdictKey(q.siteKey, q.menuHash)), floor);
        }
      }
    } finally {
      await lease?.release();
    }
    return { questionKeys, tournamentQuestions, skippedByBudget, ...(notAcquired ? { notAcquired } : {}) };
  }

  /** The provider's lease, or why it was not taken. */
  private async acquireLease(input: ResidualPassInput, total: number): Promise<ResidualProviderLease | string> {
    const { provider } = input;
    input.onProgress?.({
      phase: "resolving-residual",
      current: 0,
      total,
      percentage: 0,
      message: "Residual resolution: acquiring GPU session (switching embedders → Kev)",
    });
    try {
      return await (provider.acquire as () => Promise<ResidualProviderLease>)();
    } catch (error) {
      return `provider ${provider.id} session not acquired: ${describeError(error)}`;
    }
  }

  /** At the served version when asking; otherwise the newest verdict per site, whatever version gave it. */
  private async cachedVerdicts(
    input: ResidualPassInput,
    keys: { siteKey: string; menuHash: string }[],
    modelVersion: string | undefined,
  ): Promise<Map<string, ResidualVerdict>> {
    if (keys.length === 0) return new Map();
    const cached =
      modelVersion === undefined
        ? await input.store.findLatest(keys, input.provider.id)
        : await input.store.find(keys.map((k) => ({ ...k, modelVersion })));
    const verdicts = new Map<string, ResidualVerdict>();
    for (const verdict of cached) {
      if (verdict.model === input.provider.id) verdicts.set(verdictKey(verdict.siteKey, verdict.menuHash), verdict);
    }
    return verdicts;
  }

  /**
   * Pool of `concurrency` workers over one queue; each group's verdicts are stored as soon as it answers. A group
   * that timed out goes back to the tail once. A lost lease or a tripped breaker (see {@link tripsBreaker}) aborts
   * the asks still in flight; those count as aborted, not failed.
   */
  private async askGroups(
    groups: PendingGroup[],
    modelVersion: string,
    verdicts: Map<string, ResidualVerdict>,
    tally: AskTally,
    input: ResidualPassInput,
  ): Promise<void> {
    const failureBudget = Math.max(
      input.maxGroupFailures ?? DEFAULT_MAX_GROUP_FAILURES,
      Math.ceil((input.maxGroupFailureRate ?? DEFAULT_MAX_GROUP_FAILURE_RATE) * groups.length),
    );
    const maxConsecutive = input.maxConsecutiveGroupFailures ?? DEFAULT_MAX_CONSECUTIVE_GROUP_FAILURES;
    const controller = new AbortController();
    const pendingGroups = [...groups];
    const requeued = new Set<PendingGroup>();
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (next < pendingGroups.length && !controller.signal.aborted) {
        const group = pendingGroups[next++];
        if (!requeued.has(group)) tally.asked += group.questions.length;
        try {
          const fresh = await this.askGroup(group, modelVersion, input, controller.signal, tally);
          await input.store.put(fresh);
          tally.answered += fresh.length;
          tally.consecutiveFailures = 0;
          for (const verdict of fresh) verdicts.set(verdictKey(verdict.siteKey, verdict.menuHash), verdict);
        } catch (error) {
          if (!controller.signal.aborted && !requeued.has(group) && REQUEUE_CODES.has(errorCode(error) ?? "")) {
            requeued.add(group);
            pendingGroups.push(group);
            tally.requeued++;
            continue;
          }
          this.countFailure(group, error, tally, controller.signal);
          tally.breakerTripped ||= tripsBreaker(tally, failureBudget, maxConsecutive);
          if (tally.leaseLost || tally.breakerTripped) controller.abort();
        }
        done++;
        input.onProgress?.({
          phase: "resolving-residual",
          current: done,
          total: groups.length,
          percentage: Math.round((done / groups.length) * 100),
          message: `Residual resolution: ${done}/${groups.length} methods`,
        });
      }
    };
    const workerCount = Math.max(1, Math.min(input.concurrency, groups.length));
    await Promise.all(Array.from({ length: workerCount }, async () => worker()));
  }

  /** An error that lands after the pass aborted is the cancellation itself, not a failure of the group. */
  private countFailure(group: PendingGroup, error: unknown, tally: AskTally, signal: AbortSignal): void {
    if (signal.aborted) {
      tally.aborted++;
      return;
    }
    const code = errorCode(error) ?? "";
    if (STATE_TOO_LONG_CODES.has(code)) {
      tally.tooLong += group.questions.length;
      return;
    }
    tally.failures.push(describeError(error));
    tally.consecutiveFailures++;
    if (LEASE_LOST_CODES.has(code)) tally.leaseLost = true;
    console.error(
      `[Residual] group failed: method=${group.methodSymbolId} questions=${group.questions.length} code=${code || "UNKNOWN"}`,
    );
  }

  private async askGroup(
    group: PendingGroup,
    modelVersion: string,
    input: ResidualPassInput,
    signal: AbortSignal,
    tally: AskTally,
  ): Promise<ResidualVerdict[]> {
    const methodSource = await input.readMethodSource(group.sourceRelPath, group.methodStartLine, group.methodEndLine);
    const ask = async (source: string) =>
      input.provider.resolveGroup(
        {
          sourceRelPath: group.sourceRelPath,
          methodSymbolId: group.methodSymbolId,
          methodSource: source,
          questions: group.questions,
        },
        signal,
      );
    let answers: ResidualAnswer[];
    try {
      answers = await ask(methodSource);
    } catch (error) {
      const windowed = windowMethodSource(methodSource, group.methodStartLine, group.lines);
      if (!STATE_TOO_LONG_CODES.has(errorCode(error) ?? "") || windowed.length >= methodSource.length) throw error;
      tally.windowed++;
      answers = await ask(windowed);
    }
    return toVerdicts(group.questions, answers, input.provider.id, modelVersion, input.now());
  }
}

/** More failed groups than the budget, or `maxConsecutive` failed groups in a row. */
function tripsBreaker(tally: AskTally, failureBudget: number, maxConsecutive: number): boolean {
  return tally.failures.length > failureBudget || tally.consecutiveFailures >= maxConsecutive;
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

/** A receiver group's question, in its method. */
function groupQuestion(tournament: GroupTournament, question: ResidualQuestion): PendingQuestion {
  const { group } = tournament;
  return {
    sourceRelPath: group.sourceRelPath,
    methodSymbolId: group.methodSymbolId,
    methodStartLine: group.methodStartLine,
    methodEndLine: group.methodEndLine,
    lines: group.lines,
    question,
  };
}

/** One batch per enclosing method; a question asked twice with the same menu is asked once. */
function batchQuestions(pendingQuestions: readonly PendingQuestion[]): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  const seen = new Set<string>();
  for (const p of pendingQuestions) {
    const key = verdictKey(p.question.siteKey, p.question.menuHash);
    if (seen.has(key)) continue;
    seen.add(key);
    const groupKey = `${p.sourceRelPath}\u0000${p.methodSymbolId}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        sourceRelPath: p.sourceRelPath,
        methodSymbolId: p.methodSymbolId,
        methodStartLine: p.methodStartLine,
        methodEndLine: p.methodEndLine,
        lines: [],
        questions: [],
      };
      groups.set(groupKey, group);
    }
    for (const line of p.lines) if (!group.lines.includes(line)) group.lines.push(line);
    group.questions.push(p.question);
  }
  return [...groups.values()];
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

/** An answer for a site not asked, or picking off the menu, is dropped; a null pick (none) is kept. */
function toVerdicts(
  questions: ResidualQuestion[],
  answers: ResidualAnswer[],
  model: string,
  modelVersion: string,
  now: number,
): ResidualVerdict[] {
  const bySite = new Map(questions.map((q) => [q.siteKey, q]));
  const verdicts: ResidualVerdict[] = [];
  for (const answer of answers) {
    const question = bySite.get(answer.siteKey);
    if (!question || (answer.pick !== null && !question.candidates.includes(answer.pick))) continue;
    verdicts.push({
      siteKey: answer.siteKey,
      menuHash: question.menuHash,
      model,
      modelVersion,
      pick: answer.pick,
      p: answer.p,
      probabilities: answer.probabilities,
      questionPayload: answer.questionPayload,
      createdAt: now,
      lastSeenAt: now,
    });
  }
  return verdicts;
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

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** The message, and the cause's when the error carries one (a typed error wraps the transport failure there). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (cause: ${error.cause.message})` : error.message;
}
