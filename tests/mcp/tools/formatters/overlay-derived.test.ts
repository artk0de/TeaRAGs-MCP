/**
 * Test that formatSearchResults correctly includes derived overlay values in metaOnly mode.
 */

import { describe, expect, it } from "vitest";

import { formatSearchResults } from "../../../../src/mcp/tools/formatters/search-pipeline.js";

describe("formatSearchResults with derived overlay", () => {
  it("includes derived values in metaOnly output when overlay has only derived data", () => {
    const results = [
      {
        id: "chunk-1",
        score: 0.85,
        payload: {
          relativePath: "src/big-method.ts",
          startLine: 10,
          endLine: 200,
          language: "typescript",
          methodLines: 190,
          methodDensity: 60,
        },
        rankingOverlay: {
          preset: "decomposition",
          derived: { chunkSize: 0.72, chunkDensity: 0.5 },
        },
      },
    ];

    const result = formatSearchResults(results as never, true);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed[0].preset).toBe("decomposition");
    // derived values should be present somewhere in the output
    expect(parsed[0].derived).toBeDefined();
    expect(parsed[0].derived.chunkSize).toBe(0.72);
    expect(parsed[0].derived.chunkDensity).toBe(0.5);
  });

  it("includes both git and derived when overlay has all levels", () => {
    const results = [
      {
        id: "chunk-2",
        score: 0.7,
        payload: {
          relativePath: "src/hotspot.ts",
          startLine: 1,
          endLine: 50,
          language: "typescript",
          git: {
            file: { commitCount: 20, ageDays: 100 },
          },
        },
        rankingOverlay: {
          preset: "techDebt",
          file: { commitCount: 20, ageDays: 100 },
          derived: { churn: 0.8, age: 0.5 },
        },
      },
    ];

    const result = formatSearchResults(results as never, true);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed[0].preset).toBe("techDebt");
    expect(parsed[0].git.file.commitCount).toBe(20);
    expect(parsed[0].derived.churn).toBe(0.8);
    expect(parsed[0].derived.age).toBe(0.5);
  });
});
