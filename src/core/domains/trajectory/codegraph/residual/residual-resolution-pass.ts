/**
 * Asks a residual model about the call sites the static resolver left open,
 * caches every verdict, and applies the confident ones as `origin: "model"`
 * edges. Every run applies the FULL model edge set of the current sites —
 * `applyModelEdges` replaces the model's edges, and a static re-walk of a file
 * drops that file's model edges. A provider that is down or keeps failing ends
 * the pass `skipped`; the verdicts already held are applied all the same.
 */

import type { ResidualVerdictStore } from "../../../../adapters/duckdb/residual-verdict-store.js";
import type { ModelEdgeRow, ResidualCallSiteRow } from "../../../../contracts/types/codegraph-residual.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import type { ProgressCallback } from "../../../../types.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualPassMode,
  ResidualPassReport,
  ResidualQuestion,
  ResidualVerdict,
} from "./types.js";

export const DEFAULT_MAX_GROUP_FAILURES = 3;

/** Provider error codes that mean "this method source is too long to ask"; its sites are skipped, not failed. */
const STATE_TOO_LONG_CODES = new Set(["INFRA_KEV_STATE_TOO_LONG"]);

export interface ResidualPassInput {
  graphDb: Pick<GraphDbClient, "readResidualCallSites" | "applyModelEdges" | "markDerivedStale">;
  store: Pick<ResidualVerdictStore, "find" | "findLatest" | "put" | "touch" | "expire">;
  provider: ResidualModelProvider;
  mode: ResidualPassMode;
  /** Method groups in flight at once. */
  concurrency: number;
  menuLimit: number;
  retentionDays: number;
  readMethodSource: (relPath: string, startLine: number, endLine: number) => Promise<string>;
  /** Epoch ms. */
  now: () => number;
  onProgress?: ProgressCallback;
  maxGroupFailures?: number;
}

interface PendingGroup {
  sourceRelPath: string;
  methodSymbolId: string;
  methodStartLine: number;
  methodEndLine: number;
  questions: ResidualQuestion[];
}

interface AskTally {
  asked: number;
  answered: number;
  tooLong: number;
  failures: string[];
}

const verdictKey = (siteKey: string, menuHash: string): string => `${siteKey}\u0000${menuHash}`;

export class ResidualResolutionPass {
  async run(input: ResidualPassInput): Promise<ResidualPassReport> {
    const { provider } = input;
    const startedAt = input.now();
    const servedVersion = input.mode === "ask" ? await this.servedVersion(provider) : { version: undefined };

    const rows = await input.graphDb.readResidualCallSites();
    const eligible = rows.filter((r) => !r.menuOverflow && r.candidates.length <= input.menuLimit);
    const verdicts = await this.cachedVerdicts(input, eligible, servedVersion.version);
    const cacheHits = eligible.filter((r) => verdicts.has(verdictKey(r.siteKey, r.menuHash))).length;
    const groups = groupQuestions(eligible.filter((r) => !verdicts.has(verdictKey(r.siteKey, r.menuHash))));
    const readAt = input.now();

    const tally: AskTally = { asked: 0, answered: 0, tooLong: 0, failures: [] };
    if (servedVersion.version !== undefined) {
      await this.askGroups(groups, servedVersion.version, verdicts, tally, input);
    }
    const askedAt = input.now();

    const maxFailures = input.maxGroupFailures ?? DEFAULT_MAX_GROUP_FAILURES;
    const failureReason =
      tally.failures.length > 0 ? `${tally.failures.length} group(s) failed: ${tally.failures[0]}` : undefined;
    const reason = servedVersion.unavailable ?? failureReason;
    const skipped = servedVersion.unavailable !== undefined || tally.failures.length > maxFailures;

    const { edges, belowThreshold } = buildEdges(eligible, verdicts, provider);
    await input.graphDb.applyModelEdges(provider.id, edges);
    await input.graphDb.markDerivedStale();
    await input.store.touch(
      rows.map((r) => r.siteKey),
      provider.id,
      input.now(),
    );
    await input.store.expire(input.retentionDays, input.now());
    const finishedAt = input.now();

    return {
      outcome: skipped ? "skipped" : "completed",
      ...(reason !== undefined ? { reason } : {}),
      mode: input.mode,
      sites: rows.length,
      menuOverflow: rows.length - eligible.length,
      cacheHits,
      groups: groups.length,
      asked: tally.asked,
      answered: tally.answered,
      tooLong: tally.tooLong,
      failedGroups: tally.failures.length,
      belowThreshold,
      edgesApplied: edges.length,
      durations: {
        readMs: readAt - startedAt,
        askMs: askedAt - readAt,
        applyMs: finishedAt - askedAt,
        totalMs: finishedAt - startedAt,
      },
    };
  }

  /** The model version to ask under, or why the provider cannot be asked. */
  private async servedVersion(provider: ResidualModelProvider): Promise<{ version?: string; unavailable?: string }> {
    const unavailable = (detail: string) => ({ unavailable: `provider ${provider.id} unavailable: ${detail}` });
    try {
      const health = await provider.health();
      if (!health.ok) return unavailable(health.reason);
      return { version: await provider.version() };
    } catch (error) {
      return unavailable(errorMessage(error));
    }
  }

  /** At the served version when asking; otherwise the newest verdict per site, whatever version gave it. */
  private async cachedVerdicts(
    input: ResidualPassInput,
    eligible: ResidualCallSiteRow[],
    modelVersion: string | undefined,
  ): Promise<Map<string, ResidualVerdict>> {
    const cached =
      modelVersion === undefined
        ? await input.store.findLatest(
            eligible.map((r) => ({ siteKey: r.siteKey, menuHash: r.menuHash })),
            input.provider.id,
          )
        : await input.store.find(eligible.map((r) => ({ siteKey: r.siteKey, menuHash: r.menuHash, modelVersion })));
    const verdicts = new Map<string, ResidualVerdict>();
    for (const verdict of cached) {
      if (verdict.model === input.provider.id) verdicts.set(verdictKey(verdict.siteKey, verdict.menuHash), verdict);
    }
    return verdicts;
  }

  /** Pool of `concurrency` workers; each group's verdicts are stored as soon as it answers. */
  private async askGroups(
    groups: PendingGroup[],
    modelVersion: string,
    verdicts: Map<string, ResidualVerdict>,
    tally: AskTally,
    input: ResidualPassInput,
  ): Promise<void> {
    const maxFailures = input.maxGroupFailures ?? DEFAULT_MAX_GROUP_FAILURES;
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (next < groups.length && tally.failures.length <= maxFailures) {
        const group = groups[next++];
        tally.asked += group.questions.length;
        try {
          const fresh = await this.askGroup(group, modelVersion, input);
          await input.store.put(fresh);
          tally.answered += fresh.length;
          for (const verdict of fresh) verdicts.set(verdictKey(verdict.siteKey, verdict.menuHash), verdict);
        } catch (error) {
          if (STATE_TOO_LONG_CODES.has(errorCode(error) ?? "")) tally.tooLong += group.questions.length;
          else tally.failures.push(errorMessage(error));
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

  private async askGroup(
    group: PendingGroup,
    modelVersion: string,
    input: ResidualPassInput,
  ): Promise<ResidualVerdict[]> {
    const methodSource = await input.readMethodSource(group.sourceRelPath, group.methodStartLine, group.methodEndLine);
    const answers = await input.provider.resolveGroup({
      sourceRelPath: group.sourceRelPath,
      methodSymbolId: group.methodSymbolId,
      methodSource,
      questions: group.questions,
    });
    return toVerdicts(group.questions, answers, input.provider.id, modelVersion, input.now());
  }
}

/** One group per enclosing method; a site asked twice with the same menu is asked once. */
function groupQuestions(rows: ResidualCallSiteRow[]): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  const seen = new Set<string>();
  for (const r of rows) {
    const key = verdictKey(r.siteKey, r.menuHash);
    if (seen.has(key)) continue;
    seen.add(key);
    const groupKey = `${r.sourceRelPath}\u0000${r.methodSymbolId}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        sourceRelPath: r.sourceRelPath,
        methodSymbolId: r.methodSymbolId,
        methodStartLine: r.methodStartLine,
        methodEndLine: r.methodEndLine,
        questions: [],
      };
      groups.set(groupKey, group);
    }
    group.questions.push({
      siteKey: r.siteKey,
      menuHash: r.menuHash,
      receiverText: r.receiverText,
      member: r.member,
      kind: r.kind,
      candidates: r.candidates,
    });
  }
  return [...groups.values()];
}

/** An answer for a site not asked, or picking off the menu, is dropped. */
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
    if (!question?.candidates.includes(answer.pick)) continue;
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

function buildEdges(
  rows: ResidualCallSiteRow[],
  verdicts: Map<string, ResidualVerdict>,
  provider: ResidualModelProvider,
): { edges: ModelEdgeRow[]; belowThreshold: number } {
  const edges: ModelEdgeRow[] = [];
  const emitted = new Set<string>();
  let belowThreshold = 0;
  for (const r of rows) {
    const key = verdictKey(r.siteKey, r.menuHash);
    const verdict = verdicts.get(key);
    if (!verdict || emitted.has(key)) continue;
    emitted.add(key);
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
  return { edges, belowThreshold };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
