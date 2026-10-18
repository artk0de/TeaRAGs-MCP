/**
 * `index-codebase --resolve-residual <model>`: the flag reaches the run, an
 * unsupported model is refused at parse time, and the residual pass's report
 * reaches both the human status block and the `--json` object.
 */

import { describe, expect, it } from "vitest";
import yargs from "yargs";

import { buildIndexOptions, indexCodebaseCommand } from "../../src/cli/commands/index-codebase.js";
import { maybeCompleteProjectName } from "../../src/cli/completion.js";
import { formatIndexStatus, formatIndexStatusJson } from "../../src/cli/index-progress/status-format.js";
import { createColorizer } from "../../src/cli/infra/color.js";
import type { IndexStatus, ResidualPassReport } from "../../src/core/api/public/index.js";

function parse(argv: string[]): Record<string, unknown> {
  let failure: string | undefined;
  const parsed = yargs([])
    .command({ ...indexCodebaseCommand, handler: () => undefined })
    .exitProcess(false)
    .fail((msg: string) => {
      failure = msg;
    })
    .parse(argv) as Record<string, unknown>;
  if (failure !== undefined) throw new Error(failure);
  return parsed;
}

const REPORT: ResidualPassReport = {
  thresholds: {
    ruby: {
      block1: { threshold: 0.5, source: "calibrated", lowerBound: 0.95, n: 140 },
      fullMenu: { threshold: 0.8, source: "calibrated", lowerBound: 0.93, n: 210 },
      none: { threshold: 0.5, source: "calibrated", lowerBound: 0.91, n: 160 },
      pi: 0.18,
    },
  },
  outcome: "skipped",
  reason: "provider kev unavailable: connect ECONNREFUSED",
  mode: "ask",
  sites: 120,
  menuOverflow: 4,
  menuTooSmall: 9,
  cacheHits: 80,
  groups: 12,
  asked: 0,
  answered: 0,
  tooLong: 0,
  failedGroups: 0,
  abortedGroups: 0,
  requeuedGroups: 0,
  belowThreshold: 3,
  sitesEdged: 79,
  externalByModel: 12,
  attributeByModel: 0,
  externalByPropagation: 0,
  receiverGroups: 15,
  receiverGroupSites: 40,
  sitesEdgedByVerdict: 33,
  fanoutGroups: 4,
  fanoutEdges: 9,
  sitesEdgedByPropagation: 5,
  propagationConflicts: 1,
  tournamentGroups: 2,
  tournamentRounds: 2,
  tournamentQuestions: 8,
  namePriorGroups: 2,
  earlyAcceptedGroups: 1,
  groupsSkippedByBudget: 1,
  confirmQuestions: 3,
  confirmAccepted: 2,
  windowedGroups: 3,
  groupCacheHits: 9,
  requests: 140,
  maxQuestionsPerRequest: 8,
  requestLatencyP50Ms: 2100,
  requestLatencyP95Ms: 5400,
  peakInFlight: 48,
  edgesApplied: 77,
  derived: "stale",
  durations: { readMs: 5, askMs: 0, applyMs: 20, recomputeMs: 15, totalMs: 25 },
};

const status: IndexStatus = { isIndexed: true, status: "indexed", collectionName: "code_repo" };

describe("index-codebase --resolve-residual", () => {
  it("carries the model into IndexOptions", () => {
    expect(buildIndexOptions(parse(["index-codebase", "--resolve-residual", "kev"]) as never)).toMatchObject({
      resolveResidual: "kev",
    });
  });

  it("leaves IndexOptions without the key when the flag is absent", () => {
    expect(buildIndexOptions(parse(["index-codebase"]) as never)).not.toHaveProperty("resolveResidual");
  });

  it("refuses a model outside the supported list", () => {
    expect(() => parse(["index-codebase", "--resolve-residual", "gpt-9"])).toThrow(/Invalid values/);
  });

  it("completes the flag's value with the supported models", () => {
    expect(
      maybeCompleteProjectName(["index-codebase", "--resolve-residual", ""], ["tea-rags", "index-codebase"]),
    ).toEqual(["kev"]);
  });
});

describe("the residual pass in the run's output", () => {
  it("is reported verbatim in the --json object", () => {
    const json = formatIndexStatusJson({ ...status, residualResolution: REPORT }, { path: "/repo" }) as Record<
      string,
      unknown
    >;

    expect(json.residualResolution).toEqual(REPORT);
  });

  it("shows its outcome, edges and the skip reason in the status block", () => {
    const text = formatIndexStatus(
      { ...status, residualResolution: REPORT },
      createColorizer({ env: { NO_COLOR: "1" }, isTTY: false }),
    );

    expect(text).toContain("Residual resolution");
    expect(text).toContain("skipped (ask): provider kev unavailable: connect ECONNREFUSED");
    expect(text).toContain("120 sites, 80 from cache, 0 asked, 77 model edges applied");
    expect(text).toContain(
      "4 over the menu limit, 9 under the menu floor, 79 sites edged, 12 external by model, derived metrics stale",
    );
    expect(text).toContain(
      "thresholds ruby: block1 0.50 (calibrated) · full 0.80 (calibrated) · none 0.50 (calibrated)",
    );
    expect(text).toContain(
      "15 receiver groups (40 sites): 33 sites edged by verdict (4 groups fanned out, 9 fan-out edges), 5 by propagation (1 conflicts); 2 tournaments (8 questions, 2 rounds, 1 skipped by budget, 2 opened by name, 1 accepted on block 1), 3 confirm questions (2 accepted), 3 windowed",
    );
  });

  it("shows the failed, requeued and aborted groups in the status block", () => {
    const text = formatIndexStatus(
      { ...status, residualResolution: { ...REPORT, failedGroups: 2, requeuedGroups: 3, abortedGroups: 5 } },
      createColorizer({ env: { NO_COLOR: "1" }, isTTY: false }),
    );

    expect(text).toContain("2 groups failed, 3 requeued after a timeout, 5 aborted");
  });

  it("shows the request shape, latency and peak in flight in the status block", () => {
    const text = formatIndexStatus(
      { ...status, residualResolution: REPORT },
      createColorizer({ env: { NO_COLOR: "1" }, isTTY: false }),
    );

    expect(text).toContain(
      "140 requests (at most 8 questions), latency p50 2100 ms / p95 5400 ms, peak 48 in flight, 9 group questions from cache",
    );
  });

  it("is absent from both when no pass ran", () => {
    expect(formatIndexStatus(status, createColorizer({ env: { NO_COLOR: "1" }, isTTY: false }))).not.toContain(
      "Residual resolution",
    );
    expect(formatIndexStatusJson(status, { path: "/repo" })).not.toHaveProperty("residualResolution");
  });
});
