import { describe, expect, it } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import { gitFilters } from "../../../../../src/core/domains/trajectory/git/filters.js";
import { gitPayloadSignalDescriptors } from "../../../../../src/core/domains/trajectory/git/payload-signals.js";

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
    const result = findFilter("author").toCondition("alice");
    expect(result.must).toHaveLength(1);
    expect(result.must![0]).toEqual({
      key: "git.file.dominantAuthor",
      match: { value: "alice" },
    });
  });

  it("modifiedAfter uses git.file.lastModifiedAt (file-only)", () => {
    const result = findFilter("modifiedAfter").toCondition("2024-01-01");
    expect(result.must).toHaveLength(1);
    expect(result.must![0].key).toBe("git.file.lastModifiedAt");
    expect((result.must![0] as any).range.gte).toBeGreaterThan(0);
  });

  it("modifiedBefore uses git.file.lastModifiedAt (file-only)", () => {
    const result = findFilter("modifiedBefore").toCondition("2025-12-31");
    expect(result.must![0].key).toBe("git.file.lastModifiedAt");
  });

  it("taskId defaults to file level", () => {
    const result = findFilter("taskId").toCondition("JIRA-123");
    expect(result.must![0]).toEqual({
      key: "git.file.taskIds",
      match: { any: ["JIRA-123"] },
    });
  });

  it("taskId respects chunk level param", () => {
    const result = findFilter("taskId").toCondition("JIRA-123", "chunk");
    expect(result.must![0]).toEqual({
      key: "git.chunk.taskIds",
      match: { any: ["JIRA-123"] },
    });
  });
});

describe("level-aware filters", () => {
  it("minAgeDays always uses file-level ageDays regardless of level param", () => {
    // chunk-level ageDays is often undefined → Qdrant skips range filter on missing fields
    const defaultLevel = findFilter("minAgeDays").toCondition(30);
    expect(defaultLevel.must![0].key).toBe("git.file.ageDays");

    const explicitChunk = findFilter("minAgeDays").toCondition(30, "chunk");
    expect(explicitChunk.must![0].key).toBe("git.file.ageDays");

    const explicitFile = findFilter("minAgeDays").toCondition(30, "file");
    expect(explicitFile.must![0].key).toBe("git.file.ageDays");
  });

  it("maxAgeDays always uses file-level ageDays regardless of level param", () => {
    const defaultLevel = findFilter("maxAgeDays").toCondition(90);
    expect(defaultLevel.must![0].key).toBe("git.file.ageDays");

    const explicitChunk = findFilter("maxAgeDays").toCondition(90, "chunk");
    expect(explicitChunk.must![0].key).toBe("git.file.ageDays");

    const explicitFile = findFilter("maxAgeDays").toCondition(7, "file");
    expect(explicitFile.must![0].key).toBe("git.file.ageDays");
  });

  it("minCommitCount defaults to chunk level", () => {
    const result = findFilter("minCommitCount").toCondition(5);
    expect(result.must![0]).toEqual({
      key: "git.chunk.commitCount",
      range: { gte: 5 },
    });
  });

  it("minCommitCount respects file level param", () => {
    const result = findFilter("minCommitCount").toCondition(5, "file");
    expect(result.must![0].key).toBe("git.file.commitCount");
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
      expect(f).not.toHaveProperty("name");
      expect(f).not.toHaveProperty("defaultBound");
    }
  });

  it("satisfies PayloadSignalDescriptor type", () => {
    const descriptors: PayloadSignalDescriptor[] = gitPayloadSignalDescriptors;
    expect(descriptors).toBe(gitPayloadSignalDescriptors);
  });
});
