import { describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import {
  formatResidualReport,
  resolveCodegraphResidualCommand,
  runResolveCodegraphResidual,
} from "../../../src/cli/commands/resolve-codegraph-residual.js";
import { skippedResidualReport } from "../../../src/core/api/internal/ops/residual-resolve-port.js";

const COMPLETED = {
  ...skippedResidualReport("", "ask"),
  outcome: "completed" as const,
  sites: 120,
  menuOverflow: 3,
  menuTooSmall: 7,
  cacheHits: 80,
  groups: 10,
  asked: 40,
  answered: 38,
  tooLong: 1,
  failedGroups: 1,
  abortedGroups: 2,
  requeuedGroups: 4,
  belowThreshold: 5,
  sitesEdged: 97,
  externalByModel: 31,
  receiverGroups: 12,
  receiverGroupSites: 30,
  sitesEdgedByVerdict: 25,
  sitesEdgedByPropagation: 4,
  propagationConflicts: 1,
  tournamentGroups: 2,
  tournamentRounds: 3,
  tournamentQuestions: 9,
  namePriorGroups: 2,
  earlyAcceptedGroups: 1,
  groupsSkippedByBudget: 1,
  windowedGroups: 6,
  edgesApplied: 95,
  derived: "recomputed" as const,
  durations: { readMs: 1, askMs: 2, applyMs: 3, recomputeMs: 2, totalMs: 6 },
};
delete (COMPLETED as { reason?: string }).reason;

function parse(argv: string[]): Record<string, unknown> {
  let failure: string | undefined;
  const parsed = yargs([])
    .command({ ...resolveCodegraphResidualCommand, handler: () => undefined })
    .exitProcess(false)
    .fail((msg: string) => {
      failure = msg;
    })
    .parse(argv) as Record<string, unknown>;
  if (failure !== undefined) throw new Error(failure);
  return parsed;
}

describe("formatResidualReport", () => {
  it("prints the counts of a completed pass", () => {
    const text = formatResidualReport(COMPLETED);
    expect(text).toContain("Residual resolution (ask): completed\n");
    expect(text).toContain("  cache hits:       80\n");
    expect(text).toContain("  edges applied:    95\n");
    expect(text).toContain("  menu overflow:    3\n");
    expect(text).toContain("  menu too small:   7\n");
    expect(text).toContain("  sites edged:      97\n");
    expect(text).toContain("  external (model): 31\n");
    expect(text).toContain("  derived metrics:  recomputed\n");
    expect(text).toContain("apply 3 (recompute 2), total 6");
    expect(text).toContain("  aborted groups:   2\n");
    expect(text).toContain("  requeued groups:  4\n");
    expect(text).toContain("  receiver groups:  12 (30 sites)\n");
    expect(text).toContain("  edged by group:   25 by verdict, 4 by propagation (1 conflicts)\n");
    expect(text).toContain(
      "  tournaments:      2 groups, 3 rounds, 9 questions, 1 skipped by budget; 2 opened by name, 1 accepted on block 1\n",
    );
    expect(text).toContain("  windowed groups:  6\n");
    expect(text).toContain("total 6");
  });

  it("prints the reason of a skipped pass", () => {
    expect(formatResidualReport(skippedResidualReport("provider kev unavailable: ECONNREFUSED", "ask"))).toContain(
      "Residual resolution (ask): skipped — provider kev unavailable: ECONNREFUSED\n",
    );
  });
});

describe("resolve-codegraph-residual command", () => {
  it("requires --model and accepts only kev", () => {
    expect(() => parse(["resolve-codegraph-residual"])).toThrow(/Missing required argument: model/);
    expect(() => parse(["resolve-codegraph-residual", "--model", "gpt-9"])).toThrow(/Invalid values/);
    expect(parse(["resolve-codegraph-residual", "--model", "kev", "--project", "app", "--cache-only"])).toMatchObject({
      model: "kev",
      project: "app",
      "cache-only": true,
    });
  });

  it("runs the ask pass for the path, prints the report and exits 0", async () => {
    const out: string[] = [];
    const resolveCodegraphResidual = vi.fn().mockResolvedValue(COMPLETED);
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const code = await runResolveCodegraphResidual(
      { path: "/repo", model: "kev" },
      { createContext: async () => ({ resolveCodegraphResidual, cleanup }), write: (s) => out.push(s) },
    );

    expect(code).toBe(0);
    expect(resolveCodegraphResidual).toHaveBeenCalledWith("/repo", "kev", { mode: "ask" });
    expect(out.join("")).toContain("edges applied:    95");
    expect(cleanup).toHaveBeenCalled();
  });

  it("--cache-only runs the cacheOnly mode and forwards progress", async () => {
    const resolveCodegraphResidual = vi.fn().mockResolvedValue({ ...COMPLETED, mode: "cacheOnly" });
    const progress = vi.fn();

    await runResolveCodegraphResidual(
      { path: "/repo", model: "kev", "cache-only": true },
      { createContext: async () => ({ resolveCodegraphResidual }), write: () => undefined, progress },
    );

    expect(resolveCodegraphResidual).toHaveBeenCalledWith(
      "/repo",
      "kev",
      expect.objectContaining({ mode: "cacheOnly", onProgress: expect.any(Function) }),
    );
  });

  it("emits JSON with --json", async () => {
    const out: string[] = [];

    await runResolveCodegraphResidual(
      { path: "/repo", model: "kev", json: true },
      {
        createContext: async () => ({ resolveCodegraphResidual: vi.fn().mockResolvedValue(COMPLETED) }),
        write: (s) => out.push(s),
      },
    );

    expect(JSON.parse(out.join(""))).toEqual(COMPLETED);
  });

  it("exits 1 on a skipped pass so scripts notice", async () => {
    const code = await runResolveCodegraphResidual(
      { path: "/repo", model: "kev" },
      {
        createContext: async () => ({
          resolveCodegraphResidual: vi.fn().mockResolvedValue(skippedResidualReport("down", "ask")),
        }),
        write: () => undefined,
      },
    );

    expect(code).toBe(1);
  });
});
