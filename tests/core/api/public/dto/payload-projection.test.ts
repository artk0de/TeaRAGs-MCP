/**
 * Payload projection — the `fields` allow-list (bd tea-rags-mcp-l2lix).
 *
 * A search response carries ~40 payload fields when the caller wanted three,
 * and `metaOnly` does not help: it drops the chunk BODY, not the signals. The
 * `fields` param is an explicit allow-list of dot-paths applied server-side
 * before serialization.
 *
 * Two decisions this file pins:
 *   - The projection is EXACTLY what was asked for. No path is added back in,
 *     `relativePath` included — an allow-list that quietly keeps extras is the
 *     same defect in a smaller size.
 *   - A path that matched NOTHING across every result is reported rather than
 *     silently dropped. Returning `{}` and saying nothing is the trap an agent
 *     caller cannot debug; "no result carried git.commitCount, same leaf lives
 *     at git.file.commitCount" it can act on.
 */

import { describe, expect, it } from "vitest";

import type { SearchResult } from "../../../../../src/core/api/public/dto/explore.js";
import {
  projectSearchResultPayloads,
  type PayloadProjectionOutcome,
} from "../../../../../src/core/api/public/dto/payload-projection.js";

// ---------------------------------------------------------------------------
// Fixtures — a trimmed shape of what hybrid_search returns at level: "file"
// ---------------------------------------------------------------------------

function makeResults(): SearchResult[] {
  return [
    {
      id: "p1",
      score: 0.71,
      payload: {
        relativePath: "tests/bootstrap/env-snapshot.test.ts",
        language: "typescript",
        isTest: true,
        startLine: 1,
        endLine: 120,
        members: ["EnvSnapshot#restore", "EnvSnapshot#capture"],
        git: {
          file: { commitCount: 12, ageDays: 40, authors: ["A", "B"] },
          chunk: { commitCount: 3 },
        },
      },
      rankingOverlay: { preset: "hotspots" },
    },
    {
      id: "p2",
      score: 0.44,
      payload: {
        relativePath: "src/bootstrap/env-snapshot.ts",
        language: "typescript",
        git: { file: { commitCount: 31, ageDays: 9 } },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("projectSearchResultPayloads", () => {
  it("returns the results untouched when no fields were asked for", () => {
    const results = makeResults();
    const outcome = projectSearchResultPayloads(results, undefined);

    expect(outcome.results).toBe(results);
    expect(outcome.fieldsWarning).toBeUndefined();
  });

  it("keeps only the requested dot-paths, rebuilt at the same nesting", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["git.file.commitCount"]);

    expect(outcome.results[0]?.payload).toEqual({ git: { file: { commitCount: 12 } } });
    expect(outcome.results[1]?.payload).toEqual({ git: { file: { commitCount: 31 } } });
  });

  it("does NOT re-add relativePath or any other field the caller left out", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["git.file.commitCount"]);

    expect(outcome.results[0]?.payload).not.toHaveProperty("relativePath");
    expect(outcome.results[0]?.payload).not.toHaveProperty("members");
    expect(outcome.results[0]?.payload).not.toHaveProperty("language");
  });

  it("leaves id, score and rankingOverlay alone — the projection is payload-only", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["git.file.commitCount"]);

    expect(outcome.results[0]?.id).toBe("p1");
    expect(outcome.results[0]?.score).toBe(0.71);
    expect(outcome.results[0]?.rankingOverlay).toEqual({ preset: "hotspots" });
  });

  it("merges several paths that share a prefix into one nested object", () => {
    const outcome = projectSearchResultPayloads(makeResults(), [
      "relativePath",
      "git.file.commitCount",
      "git.chunk.commitCount",
    ]);

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: "tests/bootstrap/env-snapshot.test.ts",
      git: { file: { commitCount: 12 }, chunk: { commitCount: 3 } },
    });
  });

  it("copies a whole namespace when the path names one, arrays included", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["git.file.authors"]);

    expect(outcome.results[0]?.payload).toEqual({ git: { file: { authors: ["A", "B"] } } });
  });

  it("omits a path from the result that lacks it, without warning when another result has it", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["git.chunk.commitCount"]);

    expect(outcome.results[0]?.payload).toEqual({ git: { chunk: { commitCount: 3 } } });
    expect(outcome.results[1]?.payload).toEqual({});
    expect(outcome.fieldsWarning).toBeUndefined();
  });

  it("reports a path no result carried, and names the paths with the same leaf", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["git.commitCount"]);

    expect(outcome.fieldsWarning).toContain("git.commitCount");
    expect(outcome.fieldsWarning).toContain("git.file.commitCount");
    expect(outcome.fieldsWarning).toContain("git.chunk.commitCount");
  });

  it("reports a path with no same-leaf candidate anywhere without inventing one", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["nonsense.field"]);

    expect(outcome.fieldsWarning).toContain("nonsense.field");
    expect(outcome.fieldsWarning).not.toContain("did you mean");
  });

  it("warns only about the paths that missed, not the ones that landed", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["relativePath", "git.commitCount"]);

    expect(outcome.fieldsWarning).toContain("git.commitCount");
    expect(outcome.fieldsWarning).not.toContain('"relativePath"');
    expect(outcome.results[0]?.payload).toEqual({ relativePath: "tests/bootstrap/env-snapshot.test.ts" });
  });

  it("treats an empty or all-blank fields list as no projection at all", () => {
    const results = makeResults();

    const empty: PayloadProjectionOutcome = projectSearchResultPayloads(results, []);
    const blank: PayloadProjectionOutcome = projectSearchResultPayloads(results, ["", "   "]);

    expect(empty.results).toBe(results);
    expect(empty.fieldsWarning).toBeUndefined();
    expect(blank.results).toBe(results);
    expect(blank.fieldsWarning).toBeUndefined();
  });

  it("cannot warn when there were no results to check the paths against", () => {
    const outcome = projectSearchResultPayloads([], ["git.commitCount"]);

    expect(outcome.results).toEqual([]);
    expect(outcome.fieldsWarning).toBeUndefined();
  });

  it("does not descend through a non-object value", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["relativePath.length"]);

    expect(outcome.results[0]?.payload).toEqual({});
    expect(outcome.fieldsWarning).toContain("relativePath.length");
  });
});
