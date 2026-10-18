/**
 * Asks the residual model the calibration questions drawn from the static site
 * sample and scores each answer against the static truth. A question is the one
 * the pass asks a receiver group over the same classes, asked through the same
 * queue, caps and state builder; verdicts are cached under the calibration keys
 * (`cal:<stratum>:<siteKey>`), so a rerun asks only what changed.
 */

import type { ResidualVerdictStore } from "../../../../adapters/duckdb/residual-verdict-store.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import type { CalibrationAnswer, CalibrationStratum } from "./calibration-answer.js";
import { receiverClassQuestion } from "./receiver-group-tournament.js";
import {
  cachedVerdicts,
  emptyTally,
  ResidualAskQueue,
  verdictKey,
  type AskQueueInput,
  type PendingQuestion,
} from "./residual-ask-queue.js";
import { CALIBRATION_MIN_RECORDS } from "./residual-calibration-fit.js";
import {
  buildCalibrationStrata,
  type CalibrationItem,
  type CalibrationStrataSizes,
} from "./residual-calibration-strata.js";
import { residualQuestionFold, residualQuestionHash, servedModelVersion } from "./residual-resolution-pass.js";
import type { ResidualVerdict } from "./types.js";

export interface ResidualCalibrationInput extends AskQueueInput {
  graphDb: Pick<GraphDbClient, "readStaticSiteSample">;
  store: Pick<ResidualVerdictStore, "find" | "findLatest" | "put"> & Partial<Pick<ResidualVerdictStore, "touch">>;
  menuLimit: number;
  /** Questions per stratum; unset strata take the defaults. */
  sizes?: Partial<CalibrationStrataSizes>;
  /** Draw only this language's sample rows; absent — every row. */
  language?: string;
  /** Fewest sample rows of `language` worth asking; default {@link CALIBRATION_MIN_RECORDS}. */
  minSampleRows?: number;
}

export interface ResidualCalibrationReport {
  outcome: "completed" | "skipped";
  reason?: string;
  sampleRows: number;
  /** Questions drawn per stratum. */
  strata: CalibrationStrataSizes;
  cacheHits: number;
  asked: number;
  answered: number;
  failedRequests: number;
  /** One per question with a verdict. */
  records: CalibrationAnswer[];
}

export class ResidualCalibration {
  async run(input: ResidualCalibrationInput): Promise<ResidualCalibrationReport> {
    const { provider } = input;
    const served = await servedModelVersion(provider);
    const fold = residualQuestionFold({
      ...(provider.promptTemplate === undefined ? {} : { promptTemplate: provider.promptTemplate }),
      originContext: input.originContext ?? false,
    });
    const questionHash = (menuHash: string): string => residualQuestionHash(menuHash, fold);
    const sample = await input.graphDb.readStaticSiteSample();
    const { language } = input;
    const rows = language === undefined ? sample : sample.filter((r) => r.language === language);
    const minSampleRows = input.minSampleRows ?? CALIBRATION_MIN_RECORDS;
    if (language !== undefined && rows.length < minSampleRows) {
      return {
        outcome: "skipped",
        reason: `too few static sample rows for ${language}: ${rows.length} < ${minSampleRows}`,
        sampleRows: rows.length,
        strata: { fullMenu: 0, block1: 0, external: 0 },
        cacheHits: 0,
        asked: 0,
        answered: 0,
        failedRequests: 0,
        records: [],
      };
    }
    const items = buildCalibrationStrata(rows, {
      menuLimit: input.menuLimit,
      ...(input.sizes ? { sizes: input.sizes } : {}),
    });
    const pending = items.map((item) => calibrationQuestion(item, questionHash));
    const verdicts = await cachedVerdicts(
      input,
      pending.map((p) => ({ siteKey: p.question.siteKey, menuHash: p.question.menuHash })),
      served.version,
    );
    const isCached = (p: PendingQuestion) => verdicts.has(verdictKey(p.question.siteKey, p.question.menuHash));
    const cacheHits = pending.filter(isCached).length;

    const tally = emptyTally();
    let notAcquired: string | undefined;
    if (served.unavailable === undefined) {
      ({ notAcquired } = await new ResidualAskQueue(input, served.version, verdicts, tally, []).run(
        pending.filter((p) => !isCached(p)),
      ));
    }
    await input.store.touch?.(
      pending.map((p) => p.question.siteKey),
      provider.id,
      input.now(),
    );

    const reason = served.unavailable ?? notAcquired ?? tally.failures[0];
    const skipped = served.unavailable !== undefined || notAcquired !== undefined || tally.leaseLost;
    return {
      outcome: skipped || tally.breakerTripped ? "skipped" : "completed",
      ...(reason === undefined ? {} : { reason }),
      sampleRows: rows.length,
      strata: {
        fullMenu: countOf(items, "fullMenu"),
        block1: countOf(items, "block1"),
        external: countOf(items, "external"),
      },
      cacheHits,
      asked: tally.asked,
      answered: tally.answered,
      failedRequests: tally.failures.length,
      records: items.flatMap((item, i) => {
        const { question } = pending[i];
        const verdict = verdicts.get(verdictKey(question.siteKey, question.menuHash));
        return verdict === undefined ? [] : [scored(item, verdict)];
      }),
    };
  }
}

/** The receiver-group question over the item's classes, in the site's method. */
export function calibrationQuestion(
  item: CalibrationItem,
  questionHash: (menuHash: string) => string,
): PendingQuestion {
  const { site } = item;
  return {
    sourceRelPath: site.sourceRelPath,
    methodSymbolId: site.methodSymbolId,
    methodStartLine: site.methodStartLine,
    methodEndLine: site.methodEndLine,
    lines: [site.line],
    question: receiverClassQuestion(
      {
        receiverText: site.receiverText,
        kind: site.receiverKind === "dynamic" ? "dynamic" : "ambiguous",
        members: [site.member],
      },
      item.classes,
      item.key,
      questionHash,
    ),
  };
}

function scored(item: CalibrationItem, verdict: ResidualVerdict): CalibrationAnswer {
  return {
    stratum: item.stratum,
    p: verdict.p,
    top: verdict.pick === null ? "none" : "class",
    correct: verdict.pick === item.truth,
    menuSize: item.menuSize,
  };
}

function countOf(items: readonly CalibrationItem[], stratum: CalibrationStratum): number {
  return items.filter((i) => i.stratum === stratum).length;
}

export interface CalibrationCut {
  p: number;
  /** Answers at or above `p`. */
  n: number;
  correct: number;
  /** `null` when no answer reaches `p`. */
  accuracy: number | null;
}

export type CalibrationAccuracy = Record<CalibrationStratum, { answered: number; cuts: CalibrationCut[] }>;

/** Per stratum: answers, and the share correct among the answers at or above each cut. */
export function calibrationAccuracy(
  records: readonly CalibrationAnswer[],
  cuts: readonly number[] = [0.5, 0.7],
): CalibrationAccuracy {
  const of = (stratum: CalibrationStratum) => {
    const own = records.filter((r) => r.stratum === stratum);
    return {
      answered: own.length,
      cuts: cuts.map((p): CalibrationCut => {
        const above = own.filter((r) => r.p >= p);
        const correct = above.filter((r) => r.correct).length;
        return { p, n: above.length, correct, accuracy: above.length === 0 ? null : correct / above.length };
      }),
    };
  };
  return { fullMenu: of("fullMenu"), block1: of("block1"), external: of("external") };
}
