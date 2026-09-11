import { describe, expect, it } from "vitest";

import type {
  IndexDriftFinding,
  IndexDriftMonitor,
} from "../../../../../src/core/domains/maintenance/drift/monitor.js";
import {
  formatIndexDriftReport,
  IndexDriftReporter,
} from "../../../../../src/core/domains/maintenance/drift/report.js";
import { resolveCollectionName, validatePath } from "../../../../../src/core/infra/collection-name.js";

const fixed = (findings: IndexDriftFinding[]): IndexDriftMonitor => ({
  axis: findings[0]?.axis ?? "payloadKeys",
  check: () => findings,
});

const keyFinding: IndexDriftFinding = {
  axis: "payloadKeys",
  subject: "git.file.ageDays",
  indexed: "absent",
  current: "declared",
  remedy: { kind: "recompute", trajectories: new Set(["git"]), languages: null },
};

const languageFinding: IndexDriftFinding = {
  axis: "languageVersions",
  subject: "python.walker",
  indexed: "1",
  current: "3",
  remedy: { kind: "recompute", trajectories: new Set(["codegraph"]), languages: new Set(["python"]) },
};

describe("IndexDriftReporter", () => {
  it("returns null when no monitor reports", () => {
    expect(new IndexDriftReporter([fixed([])]).checkByCollectionName("c")).toBeNull();
  });

  it("folds findings from every monitor into one remedy", () => {
    const report = new IndexDriftReporter([fixed([keyFinding]), fixed([languageFinding])]).checkByCollectionName("c");

    expect(report?.findings).toHaveLength(2);
    expect(report?.remedy).toEqual({
      kind: "recompute",
      trajectories: new Set(["codegraph", "git"]),
      languages: null,
    });
  });

  it("renders one block per axis and exactly one Run: line", () => {
    const report = new IndexDriftReporter([fixed([keyFinding]), fixed([languageFinding])]).checkByCollectionName("c");

    const text = formatIndexDriftReport(report!);

    expect(text).toBe(
      [
        "Payload keys:",
        "  git.file.ageDays: absent → declared",
        "Language versions:",
        "  python.walker: 1 → 3",
        "Run: tea-rags index-codebase --force-enrichments codegraph,git",
      ].join("\n"),
    );
    expect(text.match(/^Run:/gm)).toHaveLength(1);
  });

  it("fills --project from the alias resolver", () => {
    const report = new IndexDriftReporter([fixed([keyFinding])], () => "taxdome").checkByCollectionName("c");

    expect(formatIndexDriftReport(report!)).toContain(
      "Run: tea-rags index-codebase --project taxdome --force-enrichments git",
    );
  });

  it("reset makes checkAndConsume report the collection again", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    reporter.reset(resolveCollectionName(await validatePath("/tmp/test-project")));

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
  });

  // Moved from schema-drift-monitor.test.ts — consumption now lives here.
  it("checkAndConsume reports a collection once per process", async () => {
    const reporter = new IndexDriftReporter([fixed([keyFinding])]);

    expect(await reporter.checkAndConsume("/tmp/test-project")).not.toBeNull();
    expect(await reporter.checkAndConsume("/tmp/test-project")).toBeNull();
  });

  it("checkAndConsume swallows an invalid path", async () => {
    // `validatePath` never throws on a string — a non-existent path falls back
    // to its absolute form — so the only input that reaches the catch is one
    // `path.resolve` itself rejects.
    const invalidPath = null as unknown as string;

    expect(await new IndexDriftReporter([fixed([keyFinding])]).checkAndConsume(invalidPath)).toBeNull();
  });
});
