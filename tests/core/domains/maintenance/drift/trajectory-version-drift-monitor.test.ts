/**
 * TrajectoryVersionDriftMonitor (bd tea-rags-mcp-xi2r9, I2).
 *
 * A trajectory whose computation changed writes different values for the same
 * history — the git chunk walk's log order, its retired ranges, its working
 * rows carried onto HEAD — while every payload KEY stays put, so the schema
 * axis is blind to it. The run that rebuilt a trajectory for every point stamps
 * its algorithm version on the registry entry; this monitor compares that stamp
 * against what the running build declares. The remedy is the trajectory's own
 * enrichment recompute, never a re-embedding `--force`.
 */

import { describe, expect, it } from "vitest";

import {
  foldIndexDriftRemedies,
  renderIndexDriftRemedy,
} from "../../../../../src/core/domains/maintenance/drift/remedy.js";
import { formatIndexDriftReport } from "../../../../../src/core/domains/maintenance/drift/report.js";
import { TrajectoryVersionDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/trajectory-version-drift-monitor.js";

const registryOf = (entry: { trajectoryVersions?: Record<string, number> } | null) => ({ get: () => entry });

describe("TrajectoryVersionDriftMonitor", () => {
  it("reports an index without the stamp as the version every index predating it was built with", () => {
    const monitor = new TrajectoryVersionDriftMonitor(registryOf({}), new Map([["git", 2]]));

    expect(monitor.check("code_x")).toEqual([
      {
        axis: "trajectoryVersions",
        subject: "git.algorithm",
        indexed: "1",
        current: "2",
        remedy: { kind: "recompute", trajectories: new Set(["git"]), languages: null },
      },
    ]);
  });

  it("reports a stamp older than the build", () => {
    const monitor = new TrajectoryVersionDriftMonitor(
      registryOf({ trajectoryVersions: { git: 2 } }),
      new Map([["git", 3]]),
    );

    expect(monitor.check("code_x")).toMatchObject([{ subject: "git.algorithm", indexed: "2", current: "3" }]);
  });

  it("is silent for a stamp the build matches", () => {
    const monitor = new TrajectoryVersionDriftMonitor(
      registryOf({ trajectoryVersions: { git: 2 } }),
      new Map([["git", 2]]),
    );

    expect(monitor.check("code_x")).toEqual([]);
  });

  it("makes no claim about a trajectory the running build does not enrich with", () => {
    const monitor = new TrajectoryVersionDriftMonitor(registryOf({}), new Map());

    expect(monitor.check("code_x")).toEqual([]);
  });

  it("makes no claim about an unregistered collection", () => {
    const monitor = new TrajectoryVersionDriftMonitor(registryOf(null), new Map([["git", 2]]));

    expect(monitor.check("code_x")).toEqual([]);
  });

  it("renders the git recompute, never a full reindex", () => {
    const monitor = new TrajectoryVersionDriftMonitor(registryOf({}), new Map([["git", 2]]));
    const findings = monitor.check("code_x");
    const remedy = foldIndexDriftRemedies(findings.map((finding) => finding.remedy));

    expect(renderIndexDriftRemedy(remedy, "probe")).toBe(
      "Run: tea-rags index-codebase --project probe --force-enrichments git",
    );
    expect(formatIndexDriftReport({ findings, remedy, projectAlias: "probe" })).toBe(
      [
        "Trajectory versions:",
        "  git.algorithm: 1 → 2",
        "Run: tea-rags index-codebase --project probe --force-enrichments git",
      ].join("\n"),
    );
  });
});
