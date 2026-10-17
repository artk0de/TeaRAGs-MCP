/**
 * The asking half of the residual pass: one queue of capped requests served by
 * a pool of `concurrency` slots. A request holds questions of ONE method (one
 * method source, one model state) and at most `maxQuestionsPerRequest`
 * questions and `maxCriteriaPerRequest` candidates; a single question larger
 * than the criteria cap travels alone. There is no round barrier: when every
 * block of a tournament's current round is answered, the tournament builds its
 * next round and puts it at the head of the queue (its rounds are the critical
 * path), while the other slots keep serving queued work. Verdicts are stored
 * per request as it answers, so a stopped run keeps every answered block and
 * the next run resumes each tournament from them.
 *
 * Budget: name-matched tournaments are charged first. Another tournament is
 * charged only while the budget left over after it still covers the most the
 * open name-matched tournaments may ask ({@link GroupTournament.questionsLeftAtMost});
 * otherwise it waits until they settle, then is charged or skipped.
 */

import type { ResidualVerdictStore } from "../../../../adapters/duckdb/residual-verdict-store.js";
import type { ProgressCallback } from "../../../../types.js";
import {
  DEFAULT_TOURNAMENT_BUDGET,
  DEFAULT_TOURNAMENT_FLOOR,
  windowMethodSource,
  type GroupTournament,
} from "./receiver-group-tournament.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualProviderLease,
  ResidualQuestion,
  ResidualVerdict,
} from "./types.js";

export const DEFAULT_MAX_GROUP_FAILURES = 3;
export const DEFAULT_MAX_GROUP_FAILURE_RATE = 0.02;
export const DEFAULT_MAX_CONSECUTIVE_GROUP_FAILURES = 5;
/** Questions one request may carry; `CODEGRAPH_RESIDUAL_MAX_QUESTIONS_PER_REQUEST`. */
export const DEFAULT_MAX_QUESTIONS_PER_REQUEST = 8;
/** Candidates one request may carry over all its questions — three full 40-class blocks; `CODEGRAPH_RESIDUAL_MAX_CRITERIA_PER_REQUEST`. */
export const DEFAULT_MAX_CRITERIA_PER_REQUEST = 120;

/** Provider error codes for a request that may answer when asked again later; it is requeued once. */
const REQUEUE_CODES = new Set(["INFRA_KEV_TIMEOUT"]);

/** Provider error codes that mean "this method source is too long to ask"; its sites are skipped, not failed. */
const STATE_TOO_LONG_CODES = new Set(["INFRA_KEV_STATE_TOO_LONG"]);

/** Provider error codes that mean the hardware lease is gone; no further request can be answered. */
const LEASE_LOST_CODES = new Set(["INFRA_KEV_SESSION_LOST"]);

export interface AskQueueInput {
  store: Pick<ResidualVerdictStore, "find" | "findLatest" | "put">;
  provider: ResidualModelProvider;
  /** Requests in flight at once. */
  concurrency: number;
  readMethodSource: (relPath: string, startLine: number, endLine: number) => Promise<string>;
  /** Epoch ms. */
  now: () => number;
  onProgress?: ProgressCallback;
  /** Failed requests tolerated however few the pass has; the budget is the larger of this and the rate. */
  maxGroupFailures?: number;
  /** Failed requests tolerated as a share of the requests built so far, e.g. 0.02. */
  maxGroupFailureRate?: number;
  /** Failed requests in a row (in completion order) that trip the breaker whatever the budget. */
  maxConsecutiveGroupFailures?: number;
  /** Smallest `p` of a tournament block winner that enters the next round. */
  tournamentFloor?: number;
  /** Tournament block questions this run may send; a group that would exceed it is skipped. */
  tournamentBudget?: number;
  /** Questions one request may carry. */
  maxQuestionsPerRequest?: number;
  /** Candidates one request may carry over all its questions; a larger single question travels alone. */
  maxCriteriaPerRequest?: number;
}

/** A question and the method it is asked in. */
export interface PendingQuestion {
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  lines: readonly number[];
  question: ResidualQuestion;
}

/** One provider request: questions of one method, within the caps. */
interface PendingRequest {
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  /** Call lines of the questions, for the window a too-long method is asked over. */
  lines: number[];
  questions: ResidualQuestion[];
  criteria: number;
}

export interface AskTally {
  asked: number;
  answered: number;
  tooLong: number;
  failures: string[];
  /** Requests cancelled in flight when the pass stopped asking. */
  aborted: number;
  /** Requests asked again at the tail after a timeout. */
  requeued: number;
  /** Failed requests in a row; an answered request restarts it. */
  consecutiveFailures: number;
  leaseLost: boolean;
  /** The failure budget or the consecutive-failure limit was exceeded. */
  breakerTripped: boolean;
  /** Requests refused as too long and asked again over a window. */
  windowed: number;
  /** Requests built with an uncached question, asked or not. */
  batches: number;
  /** Requests sent to the provider, a requeued one counted each time. */
  requests: number;
  /** Most questions any sent request carried. */
  maxQuestionsPerRequest: number;
  /** Milliseconds of every settled request. */
  latenciesMs: number[];
  /** Most requests in flight at once. */
  peakInFlight: number;
  /** Receiver-group questions answered from the verdict store. */
  groupCacheHits: number;
}

export function emptyTally(): AskTally {
  return {
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
    requests: 0,
    maxQuestionsPerRequest: 0,
    latenciesMs: [],
    peakInFlight: 0,
    groupCacheHits: 0,
  };
}

export interface AskOutcome {
  questionKeys: string[];
  tournamentQuestions: number;
  skippedByBudget: number;
  notAcquired?: string;
}

export const verdictKey = (siteKey: string, menuHash: string): string => `${siteKey}\u0000${menuHash}`;

const questionKey = (q: ResidualQuestion): string => verdictKey(q.siteKey, q.menuHash);

/** At the served version when asking; otherwise the newest verdict per site, whatever version gave it. */
export async function cachedVerdicts(
  input: Pick<AskQueueInput, "store" | "provider">,
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
 * Requests per enclosing method, cut at `maxQuestions` questions or
 * `maxCriteria` candidates; methods are never merged. A question asked twice
 * with the same menu is asked once.
 */
export function batchQuestions(
  pendingQuestions: readonly PendingQuestion[],
  caps: { maxQuestions: number; maxCriteria: number },
): PendingRequest[] {
  const open = new Map<string, PendingRequest>();
  const seen = new Set<string>();
  const requests: PendingRequest[] = [];
  for (const p of pendingQuestions) {
    const key = questionKey(p.question);
    if (seen.has(key)) continue;
    seen.add(key);
    const methodKey = `${p.sourceRelPath}\u0000${p.methodSymbolId}`;
    const criteria = p.question.candidates.length;
    let request = open.get(methodKey);
    const full =
      request !== undefined &&
      (request.questions.length >= caps.maxQuestions || request.criteria + criteria > caps.maxCriteria);
    if (request === undefined || full) {
      request = {
        sourceRelPath: p.sourceRelPath,
        methodSymbolId: p.methodSymbolId,
        methodStartLine: p.methodStartLine,
        methodEndLine: p.methodEndLine,
        lines: [],
        questions: [],
        criteria: 0,
      };
      open.set(methodKey, request);
      requests.push(request);
    }
    for (const line of p.lines) if (!request.lines.includes(line)) request.lines.push(line);
    request.questions.push(p.question);
    request.criteria += criteria;
  }
  return requests;
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

type Charge = "charged" | "wait" | "skipped";

export class ResidualAskQueue {
  private readonly queue: PendingRequest[] = [];
  private readonly owner = new Map<string, GroupTournament>();
  private readonly outstanding = new Map<GroupTournament, Set<string>>();
  private waiting: { tournament: GroupTournament; uncached: ResidualQuestion[] }[] = [];
  private readonly requeuedRequests = new Set<PendingRequest>();
  private readonly controller = new AbortController();
  private readonly questionKeys: string[] = [];
  private readonly named: GroupTournament[];
  private readonly floor: number;
  private readonly caps: { maxQuestions: number; maxCriteria: number };
  private budget: number;
  private tournamentQuestions = 0;
  private skippedByBudget = 0;
  private built = 0;
  private done = 0;
  private inFlight = 0;
  /** Completion handlers still opening the next rounds. */
  private opening = 0;
  private notAcquired: string | undefined;
  private fatal: { error: unknown } | undefined;
  private settle: { resolve: () => void; reject: (error: unknown) => void } | undefined;

  constructor(
    private readonly input: AskQueueInput,
    private readonly modelVersion: string | undefined,
    private readonly verdicts: Map<string, ResidualVerdict>,
    private readonly tally: AskTally,
    private readonly tournaments: readonly GroupTournament[],
  ) {
    this.named = tournaments.filter((t) => t.hasNamePrior);
    this.floor = input.tournamentFloor ?? DEFAULT_TOURNAMENT_FLOOR;
    this.budget = input.tournamentBudget ?? DEFAULT_TOURNAMENT_BUDGET;
    this.caps = {
      maxQuestions: Math.max(1, input.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST),
      maxCriteria: Math.max(1, input.maxCriteriaPerRequest ?? DEFAULT_MAX_CRITERIA_PER_REQUEST),
    };
  }

  /**
   * Opens every tournament's first round, queues it ahead of the site
   * questions, takes the provider's lease when something needs asking and
   * serves the queue until it drains. A tournament left without an outcome —
   * unasked or unanswered — is abandoned.
   */
  async run(siteQuestions: readonly PendingQuestion[]): Promise<AskOutcome> {
    let lease: ResidualProviderLease | undefined;
    try {
      const ordered = [...this.tournaments].sort((a, b) => Number(b.hasNamePrior) - Number(a.hasNamePrior));
      const first = await this.openRounds(ordered);
      this.queue.push(...this.build([...first, ...siteQuestions]));
      if (this.queue.length > 0 && this.canAsk()) {
        if (this.input.provider.acquire) {
          const taken = await this.acquireLease(this.queue.length);
          if (typeof taken === "string") this.notAcquired = taken;
          else lease = taken;
        }
        if (this.notAcquired === undefined) await this.drain();
      }
      for (const tournament of this.tournaments) if (tournament.outcome === undefined) tournament.abandon();
    } finally {
      await lease?.release();
    }
    return {
      questionKeys: this.questionKeys,
      tournamentQuestions: this.tournamentQuestions,
      skippedByBudget: this.skippedByBudget,
      ...(this.notAcquired !== undefined ? { notAcquired: this.notAcquired } : {}),
    };
  }

  private canAsk(): boolean {
    return (
      this.modelVersion !== undefined &&
      this.notAcquired === undefined &&
      !this.tally.leaseLost &&
      !this.tally.breakerTripped &&
      this.fatal === undefined
    );
  }

  /**
   * Builds the current round of each tournament, answers what the store holds
   * and advances through fully cached rounds; returns the uncached questions of
   * the rounds it charged. Waiting tournaments are retried at the end.
   */
  private async openRounds(ready: readonly GroupTournament[]): Promise<PendingQuestion[]> {
    const pending: PendingQuestion[] = [];
    let open = ready;
    while (open.length > 0) {
      const asking = open
        .map((tournament) => ({ tournament, questions: tournament.questions() }))
        .filter((a) => a.questions.length > 0);
      const keys = asking.flatMap((a) => a.questions.map((q) => ({ siteKey: q.siteKey, menuHash: q.menuHash })));
      this.questionKeys.push(...keys.map((k) => k.siteKey));
      const cached = await cachedVerdicts(this.input, keys, this.modelVersion);
      this.tally.groupCacheHits += cached.size;
      for (const [key, verdict] of cached) this.verdicts.set(key, verdict);
      const next: GroupTournament[] = [];
      for (const { tournament, questions } of asking) {
        const uncached = questions.filter((q) => !this.verdicts.has(questionKey(q)));
        if (uncached.length === 0) {
          this.advance(tournament);
          if (tournament.outcome === undefined) next.push(tournament);
          continue;
        }
        if (tournament.isTournament && this.canAsk()) {
          const charge = this.charge(tournament, uncached.length);
          if (charge === "wait") this.waiting.push({ tournament, uncached });
          if (charge !== "charged") continue;
        }
        pending.push(...this.claim(tournament, uncached));
      }
      open = next;
    }
    pending.push(...this.retryWaiting());
    return pending;
  }

  private advance(tournament: GroupTournament): void {
    tournament.advance((q) => this.verdicts.get(questionKey(q)), this.floor, this.input.provider.threshold);
  }

  /** Charges `count` block questions, holding back what open name-matched tournaments may still need. */
  private charge(tournament: GroupTournament, count: number): Charge {
    const reserve = tournament.hasNamePrior
      ? 0
      : this.named.reduce((n, t) => n + (t.outcome === undefined ? t.questionsLeftAtMost : 0), 0);
    if (count <= this.budget - reserve) {
      this.budget -= count;
      this.tournamentQuestions += count;
      return "charged";
    }
    if (reserve > 0) return "wait";
    tournament.abandon();
    this.skippedByBudget++;
    return "skipped";
  }

  private retryWaiting(): PendingQuestion[] {
    if (this.waiting.length === 0) return [];
    const pending: PendingQuestion[] = [];
    const still: typeof this.waiting = [];
    for (const w of this.waiting) {
      if (w.tournament.outcome !== undefined || !this.canAsk()) continue;
      const charge = this.charge(w.tournament, w.uncached.length);
      if (charge === "charged") pending.push(...this.claim(w.tournament, w.uncached));
      else if (charge === "wait") still.push(w);
    }
    this.waiting = still;
    return pending;
  }

  /** The round's uncached questions, tracked until each is answered or given up. */
  private claim(tournament: GroupTournament, uncached: readonly ResidualQuestion[]): PendingQuestion[] {
    const keys = new Set<string>();
    for (const q of uncached) {
      keys.add(questionKey(q));
      this.owner.set(questionKey(q), tournament);
    }
    this.outstanding.set(tournament, keys);
    return uncached.map((q) => groupQuestion(tournament, q));
  }

  private build(pending: readonly PendingQuestion[]): PendingRequest[] {
    const requests = batchQuestions(pending, this.caps);
    this.tally.batches += requests.length;
    this.built += requests.length;
    return requests;
  }

  /** The provider's lease, or why it was not taken. */
  private async acquireLease(total: number): Promise<ResidualProviderLease | string> {
    const { provider } = this.input;
    this.input.onProgress?.({
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

  private async drain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
      this.pump();
    });
  }

  /** Fills free slots from the head of the queue; settles once nothing is in flight or opening. */
  private pump(): void {
    const slots = Math.max(1, this.input.concurrency);
    while (this.inFlight < slots && this.queue.length > 0 && !this.controller.signal.aborted) {
      const request = this.queue.shift() as PendingRequest;
      this.inFlight++;
      this.tally.peakInFlight = Math.max(this.tally.peakInFlight, this.inFlight);
      void this.dispatch(request);
    }
    const idle = this.inFlight === 0 && this.opening === 0;
    if (!idle || (this.queue.length > 0 && !this.controller.signal.aborted)) return;
    const { settle } = this;
    this.settle = undefined;
    if (this.fatal !== undefined) settle?.reject(this.fatal.error);
    else settle?.resolve();
  }

  private async dispatch(request: PendingRequest): Promise<void> {
    let ready: GroupTournament[] = [];
    try {
      ready = await this.ask(request);
    } catch (error) {
      this.stop(error);
    }
    this.opening++;
    this.inFlight--;
    this.pump();
    try {
      if (ready.length > 0 && !this.controller.signal.aborted) {
        for (const tournament of ready) this.advance(tournament);
        const open = ready.filter((t) => t.outcome === undefined);
        this.queue.unshift(...this.build(await this.openRounds(open)));
      }
    } catch (error) {
      this.stop(error);
    } finally {
      this.opening--;
    }
    this.pump();
  }

  /** An error outside the provider's answer (store, progress renderer) ends the pass once the slots drain. */
  private stop(error: unknown): void {
    this.fatal ??= { error };
    this.controller.abort();
  }

  /**
   * Sends one request and stores its verdicts as soon as it answers. A request
   * that timed out goes back to the tail once. A lost lease or a tripped
   * breaker aborts the asks still in flight; those count as aborted, not
   * failed. Returns the tournaments whose round this request completed.
   */
  private async ask(request: PendingRequest): Promise<GroupTournament[]> {
    const { tally, input } = this;
    if (!this.requeuedRequests.has(request)) tally.asked += request.questions.length;
    tally.requests++;
    tally.maxQuestionsPerRequest = Math.max(tally.maxQuestionsPerRequest, request.questions.length);
    const startedAt = input.now();
    try {
      const fresh = await this.askOnce(request);
      tally.latenciesMs.push(input.now() - startedAt);
      await input.store.put(fresh);
      tally.answered += fresh.length;
      tally.consecutiveFailures = 0;
      for (const verdict of fresh) this.verdicts.set(verdictKey(verdict.siteKey, verdict.menuHash), verdict);
    } catch (error) {
      tally.latenciesMs.push(input.now() - startedAt);
      const { signal } = this.controller;
      if (!signal.aborted && !this.requeuedRequests.has(request) && REQUEUE_CODES.has(errorCode(error) ?? "")) {
        this.requeuedRequests.add(request);
        this.queue.push(request);
        tally.requeued++;
        return [];
      }
      this.countFailure(request, error);
      tally.breakerTripped ||= this.tripsBreaker();
      if (tally.leaseLost || tally.breakerTripped) this.controller.abort();
    }
    this.done++;
    input.onProgress?.({
      phase: "resolving-residual",
      current: this.done,
      total: this.built,
      percentage: Math.round((this.done / this.built) * 100),
      message: `Residual resolution: ${this.done}/${this.built} requests`,
    });
    return this.completed(request);
  }

  /** Tournaments with no question of their round left outstanding after `request`. */
  private completed(request: PendingRequest): GroupTournament[] {
    const ready: GroupTournament[] = [];
    for (const q of request.questions) {
      const tournament = this.owner.get(questionKey(q));
      const keys = tournament === undefined ? undefined : this.outstanding.get(tournament);
      if (tournament === undefined || keys === undefined) continue;
      keys.delete(questionKey(q));
      this.owner.delete(questionKey(q));
      if (keys.size > 0) continue;
      this.outstanding.delete(tournament);
      ready.push(tournament);
    }
    return ready;
  }

  /** More failed requests than the budget, or `maxConsecutive` failed requests in a row. */
  private tripsBreaker(): boolean {
    const { input, tally } = this;
    const failureBudget = Math.max(
      input.maxGroupFailures ?? DEFAULT_MAX_GROUP_FAILURES,
      Math.ceil((input.maxGroupFailureRate ?? DEFAULT_MAX_GROUP_FAILURE_RATE) * this.built),
    );
    const maxConsecutive = input.maxConsecutiveGroupFailures ?? DEFAULT_MAX_CONSECUTIVE_GROUP_FAILURES;
    return tally.failures.length > failureBudget || tally.consecutiveFailures >= maxConsecutive;
  }

  /** An error that lands after the pass aborted is the cancellation itself, not a failure of the request. */
  private countFailure(request: PendingRequest, error: unknown): void {
    const { tally } = this;
    if (this.controller.signal.aborted) {
      tally.aborted++;
      return;
    }
    const code = errorCode(error) ?? "";
    if (STATE_TOO_LONG_CODES.has(code)) {
      tally.tooLong += request.questions.length;
      return;
    }
    tally.failures.push(describeError(error));
    tally.consecutiveFailures++;
    if (LEASE_LOST_CODES.has(code)) tally.leaseLost = true;
    console.error(
      `[Residual] group failed: method=${request.methodSymbolId} questions=${request.questions.length} code=${code || "UNKNOWN"}`,
    );
  }

  private async askOnce(request: PendingRequest): Promise<ResidualVerdict[]> {
    const { input } = this;
    const { signal } = this.controller;
    const methodSource = await input.readMethodSource(
      request.sourceRelPath,
      request.methodStartLine,
      request.methodEndLine,
    );
    const ask = async (source: string) =>
      input.provider.resolveGroup(
        {
          sourceRelPath: request.sourceRelPath,
          methodSymbolId: request.methodSymbolId,
          methodSource: source,
          questions: request.questions,
        },
        signal,
      );
    let answers: ResidualAnswer[];
    try {
      answers = await ask(methodSource);
    } catch (error) {
      const windowed = windowMethodSource(methodSource, request.methodStartLine, request.lines);
      if (!STATE_TOO_LONG_CODES.has(errorCode(error) ?? "") || windowed.length >= methodSource.length) throw error;
      this.tally.windowed++;
      answers = await ask(windowed);
    }
    return toVerdicts(request.questions, answers, input.provider.id, this.modelVersion as string, input.now());
  }
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

/** The nearest-rank percentile of `values`, 0 when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** The message, and the cause's when the error carries one (a typed error wraps the transport failure there). */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (cause: ${error.cause.message})` : error.message;
}
