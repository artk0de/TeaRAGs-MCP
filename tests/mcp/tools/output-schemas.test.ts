import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SearchResultOutputSchema } from "../../../src/mcp/tools/output-schemas.js";

describe("SearchResultOutputSchema", () => {
  const schema = z.object(SearchResultOutputSchema);

  it("validates a minimal search result", () => {
    const result = schema.parse({
      results: [
        {
          score: 0.85,
          relativePath: "src/auth.ts",
          startLine: 10,
          endLine: 30,
          language: "typescript",
        },
      ],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBe(0.85);
  });

  it("validates result with ranking overlay", () => {
    const result = schema.parse({
      results: [
        {
          score: 0.9,
          relativePath: "src/db.ts",
          startLine: 1,
          endLine: 50,
          rankingOverlay: {
            preset: "techDebt",
            derived: { recency: 0.3, churn: 0.8 },
          },
        },
      ],
    });
    expect(result.results[0].rankingOverlay?.preset).toBe("techDebt");
  });

  it("validates result with content field", () => {
    const result = schema.parse({
      results: [
        {
          score: 0.7,
          relativePath: "src/main.ts",
          content: "function main() {}",
        },
      ],
    });
    expect(result.results[0].content).toBe("function main() {}");
  });

  it("validates result with git metadata", () => {
    const result = schema.parse({
      results: [
        {
          score: 0.8,
          relativePath: "src/api.ts",
          git: {
            dominantAuthor: "John",
            commitCount: 5,
            ageDays: 30,
          },
        },
      ],
    });
    expect(result.results[0].git).toBeDefined();
  });

  it("validates response with level field", () => {
    const result = schema.parse({
      results: [],
      level: "file",
    });
    expect(result.level).toBe("file");
  });

  it("validates response with driftWarning", () => {
    const result = schema.parse({
      results: [],
      driftWarning: "Index is 5 days old",
    });
    expect(result.driftWarning).toBe("Index is 5 days old");
  });

  it("validates empty results", () => {
    const result = schema.parse({ results: [] });
    expect(result.results).toHaveLength(0);
  });

  it("rejects missing results field", () => {
    expect(() => schema.parse({})).toThrow();
  });
});
