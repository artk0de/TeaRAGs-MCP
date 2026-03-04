import { describe, expect, it } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import { gitFilters } from "../../../../src/core/trajectory/git/filters.js";
import { gitPayloadSignalDescriptors } from "../../../../src/core/trajectory/git/payload-signals.js";

const findFilter = (param: string) => gitFilters.find((f) => f.param === param)!;

describe("git filter descriptors", () => {
  it("exports 7 filter descriptors", () => {
    expect(gitFilters).toHaveLength(7);
  });

  it("each filter has required fields", () => {
    for (const f of gitFilters) {
      expect(f.param).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(typeof f.toCondition).toBe("function");
      expect(["string", "number", "boolean", "string[]"]).toContain(f.type);
    }
  });

  it("author filter uses git.file.dominantAuthor (file-only)", () => {
    const conditions = findFilter("author").toCondition("alice");
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toEqual({
      key: "git.file.dominantAuthor",
      match: { value: "alice" },
    });
  });

  it("modifiedAfter uses git.file.lastModifiedAt (file-only)", () => {
    const conditions = findFilter("modifiedAfter").toCondition("2024-01-01");
    expect(conditions).toHaveLength(1);
    expect(conditions[0].key).toBe("git.file.lastModifiedAt");
    expect((conditions[0] as any).range.gte).toBeGreaterThan(0);
  });

  it("modifiedBefore uses git.file.lastModifiedAt (file-only)", () => {
    const conditions = findFilter("modifiedBefore").toCondition("2025-12-31");
    expect(conditions[0].key).toBe("git.file.lastModifiedAt");
  });

  it("taskId defaults to file level", () => {
    const conditions = findFilter("taskId").toCondition("JIRA-123");
    expect(conditions[0]).toEqual({
      key: "git.file.taskIds",
      match: { any: ["JIRA-123"] },
    });
  });

  it("taskId respects chunk level param", () => {
    const conditions = findFilter("taskId").toCondition("JIRA-123", "chunk");
    expect(conditions[0]).toEqual({
      key: "git.chunk.taskIds",
      match: { any: ["JIRA-123"] },
    });
  });
});

describe("level-aware filters", () => {
  it("minAgeDays defaults to chunk level", () => {
    const conditions = findFilter("minAgeDays").toCondition(30);
    expect(conditions[0]).toEqual({
      key: "git.chunk.ageDays",
      range: { gte: 30 },
    });
  });

  it("minAgeDays respects file level param", () => {
    const conditions = findFilter("minAgeDays").toCondition(30, "file");
    expect(conditions[0].key).toBe("git.file.ageDays");
  });

  it("maxAgeDays defaults to chunk level", () => {
    const conditions = findFilter("maxAgeDays").toCondition(90);
    expect(conditions[0]).toEqual({
      key: "git.chunk.ageDays",
      range: { lte: 90 },
    });
  });

  it("maxAgeDays respects file level param", () => {
    const conditions = findFilter("maxAgeDays").toCondition(7, "file");
    expect(conditions[0].key).toBe("git.file.ageDays");
  });

  it("minCommitCount defaults to chunk level", () => {
    const conditions = findFilter("minCommitCount").toCondition(5);
    expect(conditions[0]).toEqual({
      key: "git.chunk.commitCount",
      range: { gte: 5 },
    });
  });

  it("minCommitCount respects file level param", () => {
    const conditions = findFilter("minCommitCount").toCondition(5, "file");
    expect(conditions[0].key).toBe("git.file.commitCount");
  });
});

describe("git payload signal descriptors", () => {
  it("exports file-level and chunk-level fields", () => {
    expect(gitPayloadSignalDescriptors.length).toBeGreaterThan(15);
    const fileFields = gitPayloadSignalDescriptors.filter((f) => f.key.startsWith("git.file."));
    const chunkFields = gitPayloadSignalDescriptors.filter((f) => f.key.startsWith("git.chunk."));
    expect(fileFields.length).toBeGreaterThanOrEqual(12);
    expect(chunkFields.length).toBeGreaterThanOrEqual(9);
  });

  it("each entry has only PayloadSignalDescriptor properties (key, type, description)", () => {
    for (const f of gitPayloadSignalDescriptors) {
      expect(f.key).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(["string", "number", "boolean", "string[]", "timestamp"]).toContain(f.type);
      // PayloadSignalDescriptor must NOT have `name` or `defaultBound`
      expect(f).not.toHaveProperty("name");
      expect(f).not.toHaveProperty("defaultBound");
    }
  });

  it("satisfies PayloadSignalDescriptor type", () => {
    // Type-level check: ensure array is assignable to PayloadSignalDescriptor[]
    const descriptors: PayloadSignalDescriptor[] = gitPayloadSignalDescriptors;
    expect(descriptors).toBe(gitPayloadSignalDescriptors);
  });
});
