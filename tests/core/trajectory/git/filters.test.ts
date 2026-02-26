import { describe, expect, it } from "vitest";

import { gitFilters } from "../../../../src/core/trajectory/git/filters.js";
import { gitPayloadFields } from "../../../../src/core/trajectory/git/payload-fields.js";

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

  it("author filter produces match condition", () => {
    const author = gitFilters.find((f) => f.param === "author")!;
    const conditions = author.toCondition("alice");
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toEqual({
      key: "git.dominantAuthor",
      match: { value: "alice" },
    });
  });

  it("minAgeDays filter produces range.gte condition", () => {
    const filter = gitFilters.find((f) => f.param === "minAgeDays")!;
    const conditions = filter.toCondition(30);
    expect(conditions[0]).toEqual({
      key: "git.ageDays",
      range: { gte: 30 },
    });
  });

  it("maxAgeDays filter produces range.lte condition", () => {
    const filter = gitFilters.find((f) => f.param === "maxAgeDays")!;
    const conditions = filter.toCondition(90);
    expect(conditions[0]).toEqual({
      key: "git.ageDays",
      range: { lte: 90 },
    });
  });

  it("modifiedAfter converts ISO date to timestamp", () => {
    const filter = gitFilters.find((f) => f.param === "modifiedAfter")!;
    const conditions = filter.toCondition("2024-01-01");
    expect(conditions).toHaveLength(1);
    const cond = conditions[0] as any;
    expect(cond.key).toBe("git.lastModifiedAt");
    expect(cond.range.gte).toBeGreaterThan(0);
  });

  it("taskId filter produces match.any condition", () => {
    const filter = gitFilters.find((f) => f.param === "taskId")!;
    const conditions = filter.toCondition("JIRA-123");
    expect(conditions[0]).toEqual({
      key: "git.taskIds",
      match: { any: ["JIRA-123"] },
    });
  });

  it("minCommitCount filter produces range.gte", () => {
    const filter = gitFilters.find((f) => f.param === "minCommitCount")!;
    const conditions = filter.toCondition(5);
    expect(conditions[0]).toEqual({
      key: "git.commitCount",
      range: { gte: 5 },
    });
  });
});

describe("git payload field docs", () => {
  it("exports file-level and chunk-level fields", () => {
    expect(gitPayloadFields.length).toBeGreaterThan(15);
    const fileFields = gitPayloadFields.filter((f) => f.key.startsWith("git.file."));
    const chunkFields = gitPayloadFields.filter((f) => f.key.startsWith("git.chunk."));
    expect(fileFields.length).toBeGreaterThanOrEqual(12);
    expect(chunkFields.length).toBeGreaterThanOrEqual(8);
  });

  it("each field has required Signal properties", () => {
    for (const f of gitPayloadFields) {
      expect(f.key).toBeTruthy();
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(["string", "number", "boolean", "string[]", "timestamp"]).toContain(f.type);
    }
  });
});
