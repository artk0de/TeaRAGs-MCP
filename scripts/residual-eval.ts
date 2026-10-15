#!/usr/bin/env tsx
/**
 * Residual-resolution eval gate against a Kev endpoint.
 *
 * Asks every fixture site as a one-question group through the same
 * `KevResidualProvider` the codegraph pass uses (built by
 * `ResidualModelProviderFactory`), then prints accuracy (all / naming-miss /
 * naming-hit) and coverage + precision at p >= 0.5 / 0.7 / 0.9. With `--gate`
 * the exit code is 1 when accuracy falls below 0.93 overall or 0.80 on the
 * sites whose parameter name does not name the class.
 *
 * Live invocation (needs a Kev endpoint; the GPU is shared, so run it through
 * a broker session, never in CI):
 *
 *   npx tsx scripts/residual-eval.ts --kev-url http://192.168.1.71:8009 --gate
 *
 * Flags: --kev-url <url[,url]>  --sites <jsonl>  --concurrency <n>  --gate
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { candidateClass } from "../src/core/adapters/kev/kev-residual-provider.js";
import type { ResidualModelProvider, ResidualQuestionGroup } from "../src/core/contracts/types/codegraph-residual.js";
import { ResidualModelProviderFactory } from "../src/core/domains/trajectory/codegraph/residual/residual-model-provider-factory.js";

export interface EvalSite {
  file: string;
  line: number;
  method: string;
  param: string;
  member: string;
  truth: string;
  candidates: string[];
  all_candidates: number;
  naming_hit: boolean;
  source: string;
}

export interface EvalOutcome {
  site: EvalSite;
  /** Picked class. */
  pick: string;
  p: number;
}

export interface EvalScore {
  total: number;
  accuracy: { all: number; namingMiss: number; namingHit: number };
  atThreshold: { threshold: number; coverage: number; precision: number }[];
}

/** The gate's bars: accuracy overall and on sites where the parameter name does not name the class. */
export const BASELINE = { all: 0.93, namingMiss: 0.8 } as const;

const DEFAULT_SITES = fileURLToPath(new URL("../tests/fixtures/residual-eval/sites40.jsonl", import.meta.url));
const THRESHOLDS = [0.5, 0.7, 0.9] as const;
const KEV_THRESHOLD = 0.7;

const ratio = (hits: number, of: number): number => (of === 0 ? 0 : hits / of);

export function scoreOutcomes(outcomes: EvalOutcome[], thresholds: readonly number[] = THRESHOLDS): EvalScore {
  const correct = (outcome: EvalOutcome): boolean => outcome.pick === outcome.site.truth;
  const accuracyOf = (subset: EvalOutcome[]): number => ratio(subset.filter(correct).length, subset.length);
  return {
    total: outcomes.length,
    accuracy: {
      all: accuracyOf(outcomes),
      namingMiss: accuracyOf(outcomes.filter((outcome) => !outcome.site.naming_hit)),
      namingHit: accuracyOf(outcomes.filter((outcome) => outcome.site.naming_hit)),
    },
    atThreshold: thresholds.map((threshold) => {
      const kept = outcomes.filter((outcome) => outcome.p >= threshold);
      return {
        threshold,
        coverage: ratio(kept.length, outcomes.length),
        precision: ratio(kept.filter(correct).length, kept.length),
      };
    }),
  };
}

export function gateFailures(score: EvalScore): string[] {
  const failures: string[] = [];
  if (score.accuracy.all < BASELINE.all) {
    failures.push(`accuracy ${score.accuracy.all.toFixed(3)} < bar ${BASELINE.all}`);
  }
  if (score.accuracy.namingMiss < BASELINE.namingMiss) {
    failures.push(`naming-miss accuracy ${score.accuracy.namingMiss.toFixed(3)} < bar ${BASELINE.namingMiss}`);
  }
  return failures;
}

export function siteGroup(site: EvalSite, index: number): ResidualQuestionGroup {
  return {
    sourceRelPath: site.file,
    methodSymbolId: site.method,
    methodSource: site.source,
    questions: [
      {
        siteKey: `site-${index}`,
        menuHash: `eval-${index}`,
        receiverText: site.param,
        member: site.member,
        kind: "ambiguous",
        candidates: site.candidates.map((name) => `${name}#${site.member}`),
      },
    ],
  };
}

/** Asks every site through the provider, `concurrency` at a time; outcomes keep the sites' order. */
export async function evaluateSites(
  provider: ResidualModelProvider,
  sites: readonly EvalSite[],
  concurrency: number,
): Promise<EvalOutcome[]> {
  const outcomes: EvalOutcome[] = Array.from({ length: sites.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sites.length) {
      const index = next++;
      const [answer] = await provider.resolveGroup(siteGroup(sites[index], index));
      outcomes[index] = { site: sites[index], pick: candidateClass(answer.pick), p: answer.p };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => worker()));
  return outcomes;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readSites(path: string): EvalSite[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalSite);
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const kevUrl = argValue("--kev-url");
  if (!kevUrl) {
    throw new Error("usage: residual-eval.ts --kev-url <url[,url]> [--sites <jsonl>] [--concurrency N] [--gate]");
  }
  const provider = ResidualModelProviderFactory.create("kev", {
    kevUrls: kevUrl.split(","),
    kevThreshold: KEV_THRESHOLD,
  });
  const health = await provider.health();
  if (!health.ok) throw new Error(`Kev unavailable: ${health.reason}`);
  process.stdout.write(`model: ${await provider.version()}\n`);

  const sites = readSites(argValue("--sites") ?? DEFAULT_SITES);
  const score = scoreOutcomes(await evaluateSites(provider, sites, Number(argValue("--concurrency") ?? "8")));
  process.stdout.write(
    `sites: ${score.total}\n` +
      `accuracy  all ${percent(score.accuracy.all)}  naming-miss ${percent(score.accuracy.namingMiss)}  ` +
      `naming-hit ${percent(score.accuracy.namingHit)}\n${score.atThreshold
        .map((row) => `p>=${row.threshold}  coverage ${percent(row.coverage)}  precision ${percent(row.precision)}\n`)
        .join("")}`,
  );
  if (!process.argv.includes("--gate")) return;
  const failures = gateFailures(score);
  if (failures.length === 0) {
    process.stdout.write("GATE PASSED\n");
    return;
  }
  process.stderr.write(`GATE FAILED\n${failures.map((failure) => `  ${failure}\n`).join("")}`);
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
