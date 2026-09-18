/**
 * Which language partitions a run's collection is split into (bd
 * tea-rags-mcp-sgo8v). A partition is a pinned worker holding a full copy of
 * the run's pass-1 state, so the plan only splits where a second pass-2 thread
 * has real work to do: the largest language alone, everything else together,
 * and only when BOTH sides clear the files-per-thread bar the extraction
 * fan-out already uses.
 */
import { describe, expect, it } from "vitest";

import { planLanguageAffinity } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/language-affinity-plan.js";

const BY_EXTENSION = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".rb": "ruby",
  ".js": "javascript",
  ".py": "python",
};

function files(count: number, dir: string, ext: string): string[] {
  return Array.from({ length: count }, (_, i) => `${dir}/f${i}${ext}`);
}

function plan(runRelPaths: string[], overrides: { minFilesPerPartition?: number; maxPartitions?: number } = {}) {
  return planLanguageAffinity({
    collectionName: "code_x_v3",
    runRelPaths,
    partitionByExtension: BY_EXTENSION,
    minFilesPerPartition: overrides.minFilesPerPartition ?? 10,
    maxPartitions: overrides.maxPartitions ?? 2,
  });
}

describe("planLanguageAffinity", () => {
  it("puts the largest language alone and everything else together", () => {
    const result = plan([
      ...files(30, "web", ".ts"),
      ...files(10, "web", ".tsx"),
      ...files(25, "app", ".rb"),
      ...files(3, "legacy", ".js"),
      "README.md",
    ]);

    expect(result).not.toBeNull();
    const labels = result?.partitions.map((p) => p.label);
    expect(labels).toEqual(["typescript", "javascript+ruby"]);
    expect(result?.partitions.map((p) => p.fileCount)).toEqual([40, 28]);
    expect(result?.partitions.map((p) => p.routingKey)).toEqual([
      "code_x_v3::typescript",
      "code_x_v3::javascript+ruby",
    ]);
  });

  it("routes every path to the partition of its language, and a path of no language to the completion owner", () => {
    const result = plan([...files(30, "web", ".ts"), ...files(20, "app", ".rb"), ...files(2, "legacy", ".js")]);

    expect(result?.partitionOfPath("web/f1.ts").label).toBe("typescript");
    expect(result?.partitionOfPath("web/x.tsx").label).toBe("typescript");
    expect(result?.partitionOfPath("app/models/user.rb").label).toBe("javascript+ruby");
    expect(result?.partitionOfPath("legacy/old.js").label).toBe("javascript+ruby");
    expect(result?.partitionOfPath("README.md")).toBe(result?.completionOwner);
    expect(result?.partitionOfLanguage("python")).toBe(result?.completionOwner);
    expect(result?.partitionOfLanguage("typescript").label).toBe("typescript");
  });

  it("gives collection completion to the smaller partition — the one not carrying the critical path", () => {
    const tsHeavy = plan([...files(40, "web", ".ts"), ...files(20, "app", ".rb")]);
    expect(tsHeavy?.completionOwner.label).toBe("ruby");

    const rubyHeavy = plan([...files(15, "web", ".ts"), ...files(40, "app", ".rb")]);
    expect(rubyHeavy?.completionOwner.label).toBe("typescript");
  });

  it("does not split a run one side of which is too small to earn a thread", () => {
    expect(plan([...files(40, "web", ".ts"), ...files(9, "app", ".rb")])).toBeNull();
    expect(plan([...files(9, "web", ".ts"), ...files(9, "app", ".rb")], { minFilesPerPartition: 10 })).toBeNull();
  });

  it("does not split a single-language run, or a pool that cannot host two partitions", () => {
    expect(plan(files(100, "web", ".ts"))).toBeNull();
    expect(plan([...files(40, "web", ".ts"), ...files(40, "app", ".rb")], { maxPartitions: 1 })).toBeNull();
  });

  it("is deterministic when two languages tie on file count", () => {
    const a = plan([...files(20, "app", ".rb"), ...files(20, "web", ".ts")]);
    const b = plan([...files(20, "web", ".ts"), ...files(20, "app", ".rb")]);

    expect(a?.partitions.map((p) => p.label)).toEqual(b?.partitions.map((p) => p.label));
    expect(a?.completionOwner.label).toBe(b?.completionOwner.label);
  });
});
