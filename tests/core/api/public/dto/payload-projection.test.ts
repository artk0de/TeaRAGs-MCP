/**
 * Payload projection — the `fields` allow-list (bd tea-rags-mcp-l2lix).
 *
 * A search response carries ~40 payload fields when the caller wanted three,
 * and `metaOnly` does not help: it drops the chunk BODY, not the signals. The
 * `fields` param is an explicit allow-list of dot-paths applied server-side
 * before serialization.
 *
 * Two decisions this file pins:
 *   - Requested fields stay allowlisted, with the real relativePath retained
 *     as mandatory source identity. Other unrequested payload fields stay out.
 *   - A path that matched NOTHING across every result is reported rather than
 *     silently dropped. Returning `{}` and saying nothing is the trap an agent
 *     caller cannot debug; "no result carried git.commitCount, same leaf lives
 *     at git.file.commitCount" it can act on.
 */

import { describe, expect, it } from "vitest";

import type { SearchResult } from "../../../../../src/core/api/public/dto/explore.js";
import {
  DEFAULT_META_ONLY_FIELDS,
  DEFAULT_SEARCH_FIELDS,
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

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: "tests/bootstrap/env-snapshot.test.ts",
      git: { file: { commitCount: 12 } },
    });
    expect(outcome.results[1]?.payload).toEqual({
      relativePath: "src/bootstrap/env-snapshot.ts",
      git: { file: { commitCount: 31 } },
    });
  });

  it("retains mandatory relativePath but no other field the caller left out", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["git.file.commitCount"]);

    expect(outcome.results[0]?.payload?.relativePath).toBe("tests/bootstrap/env-snapshot.test.ts");
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

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: "tests/bootstrap/env-snapshot.test.ts",
      git: { file: { authors: ["A", "B"] } },
    });
  });

  it("omits a path from the result that lacks it, without warning when another result has it", () => {
    const outcome = projectSearchResultPayloads(makeResults(), ["git.chunk.commitCount"]);

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: "tests/bootstrap/env-snapshot.test.ts",
      git: { chunk: { commitCount: 3 } },
    });
    expect(outcome.results[1]?.payload).toEqual({ relativePath: "src/bootstrap/env-snapshot.ts" });
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

  // bd tea-rags-mcp-9f0yn.12 (eval C3): every agent guessed `git.file.dominantAuthor` for
  // `git.file.blameDominantAuthor`; a warning with no suggestion cost one more call.
  it("a near-miss leaf under the same parent gets a did-you-mean naming the real key", () => {
    const results: SearchResult[] = [
      {
        id: "n1",
        score: 0.5,
        payload: {
          relativePath: "src/a.ts",
          git: { file: { blameDominantAuthor: "ann", blameDominantAuthorPct: 80, commitCount: 3 } },
        },
      },
    ];

    expect(projectSearchResultPayloads(results, ["git.file.dominantAuthor"]).fieldsWarning).toBe(
      'fields: no result carried "git.file.dominantAuthor" — did you mean git.file.blameDominantAuthor, ' +
        "git.file.blameDominantAuthorPct?",
    );
    // A one-letter typo is a near miss too; an unrelated sibling is not.
    expect(projectSearchResultPayloads(results, ["git.file.comitCount"]).fieldsWarning).toBe(
      'fields: no result carried "git.file.comitCount" — did you mean git.file.commitCount?',
    );
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

    expect(outcome.results[0]?.payload).toEqual({ relativePath: "tests/bootstrap/env-snapshot.test.ts" });
    expect(outcome.fieldsWarning).toContain("relativePath.length");
  });

  it("warns with unlocated result ids without inventing paths or losing requested-field warnings", () => {
    const results: SearchResult[] = [
      { id: "missing-path", score: 1, payload: { symbolId: "Worker#run", content: "return 1;" } },
      { id: "invalid-path", score: 0.5, payload: { relativePath: " ", symbolId: "Worker#run" } },
    ];

    for (const fields of [undefined, ["symbolId", "missing.field"]]) {
      const outcome = projectSearchResultPayloads(results, fields);
      expect(outcome.fieldsWarning).toContain("missing-path");
      expect(outcome.fieldsWarning).toContain("invalid-path");
      expect(outcome.results[0]?.payload).not.toHaveProperty("relativePath");
      if (fields) {
        expect(outcome.fieldsWarning).toContain("missing.field");
        expect(outcome.results[1]?.payload).not.toHaveProperty("relativePath");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Default projection by call mode (agent turn economy N4, bd tea-rags-mcp-r4rl1)
//
// With `fields` absent the payload is narrowed per call mode: a metaOnly row is
// a locator an agent drills from, a content row is locator + body + navigation.
// Raw git / codegraph / imports / enrichedAt are what made a row ~1–1.5k chars,
// so they stay out unless a rerank asked for signals. `fields` stays exact.
// ---------------------------------------------------------------------------

function makeFullHit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "h1",
    score: 0.8,
    payload: {
      relativePath: "src/core/domains/explore/strategies/symbol.ts",
      symbolId: "SymbolSearchStrategy#postProcess",
      startLine: 380,
      endLine: 410,
      chunkType: "function",
      language: "typescript",
      signature: "protected override async postProcess(",
      content: "protected override async postProcess(\n  results: ExploreResult[],\n) {}",
      navigation: { prevSymbolId: "SymbolSearchStrategy#resolve", nextSymbolId: "SymbolSearchStrategy#match" },
      imports: ["./base.js", "../reranker.js"],
      methodLines: 30,
      git: {
        file: { commitCount: 12, taskIds: ["tea-rags-mcp-a"], blameDominantAuthor: "x", enrichedAt: "2026-10-01" },
        chunk: { commitCount: 3, taskIds: ["tea-rags-mcp-b"] },
      },
      codegraph: { symbols: { file: { fanIn: 4, enrichedAt: "2026-10-01" } } },
    },
    ...overrides,
  };
}

const LOCATOR = {
  relativePath: "src/core/domains/explore/strategies/symbol.ts",
  symbolId: "SymbolSearchStrategy#postProcess",
  startLine: 380,
  endLine: 410,
  chunkType: "function",
  language: "typescript",
  signature: "protected override async postProcess(",
};

describe("projectSearchResultPayloads — default projection by call mode (N4)", () => {
  it("narrows a metaOnly row without rerank to the locator", () => {
    const outcome = projectSearchResultPayloads([makeFullHit()], undefined, { metaOnly: true, reranked: false });

    expect(outcome.results[0]?.payload).toEqual(LOCATOR);
    expect(outcome.fieldsWarning).toBeUndefined();
  });

  it("keeps the rankingOverlay on a reranked metaOnly row and drops the raw git / codegraph", () => {
    const overlay = { preset: "hotspots", chunk: { commitCount: { value: 3, label: "typical" } } };
    const outcome = projectSearchResultPayloads([makeFullHit({ rankingOverlay: overlay })], undefined, {
      metaOnly: true,
      reranked: true,
    });

    expect(outcome.results[0]?.payload).toEqual(LOCATOR);
    expect(outcome.results[0]?.rankingOverlay).toEqual(overlay);
  });

  it("gives a content row locator + content + navigation, without imports / git / codegraph / enrichedAt", () => {
    const hit = makeFullHit();
    const outcome = projectSearchResultPayloads([hit], undefined, { metaOnly: false, reranked: false });
    const payload = outcome.results[0]?.payload ?? {};

    expect(payload.content).toBe(hit.payload?.content);
    expect(payload.navigation).toEqual(hit.payload?.navigation);
    expect(payload.relativePath).toBe(LOCATOR.relativePath);
    expect(payload.symbolId).toBe(LOCATOR.symbolId);
    expect(payload).not.toHaveProperty("imports");
    expect(payload).not.toHaveProperty("git");
    expect(payload).not.toHaveProperty("codegraph");
    expect(payload).not.toHaveProperty("methodLines");
  });

  it("leaves a reranked content row's payload whole — the signals were asked for", () => {
    const hit = makeFullHit({ rankingOverlay: { preset: "techDebt" } });
    const outcome = projectSearchResultPayloads([hit], undefined, { metaOnly: false, reranked: true });

    expect(outcome.results[0]?.payload).toEqual(hit.payload);
  });

  it("keeps an outline row's content — the outline text is the answer", () => {
    const outline = makeFullHit({
      payload: {
        relativePath: "src/a.ts",
        language: "typescript",
        content: "src/a.ts\n  Foo\n  Foo#bar",
        chunkCount: 2,
      },
    });
    const outcome = projectSearchResultPayloads([outline], undefined, { metaOnly: false, reranked: false });

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: "src/a.ts",
      language: "typescript",
      content: "src/a.ts\n  Foo\n  Foo#bar",
    });
  });

  it("keeps treeState on the row through the default projection", () => {
    const outcome = projectSearchResultPayloads([makeFullHit({ treeState: "modified" })], undefined, {
      metaOnly: true,
      reranked: false,
    });

    expect(outcome.results[0]?.treeState).toBe("modified");
  });

  it("applies `fields` with only mandatory relativePath added", () => {
    const outcome = projectSearchResultPayloads([makeFullHit()], ["git.file.commitCount"], {
      metaOnly: true,
      reranked: false,
    });

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: LOCATOR.relativePath,
      git: { file: { commitCount: 12 } },
    });
  });

  it('projects the whole git subtree for fields: ["git"], so the old answer stays reachable', () => {
    const hit = makeFullHit();
    const outcome = projectSearchResultPayloads([hit], ["git"], { metaOnly: true, reranked: false });

    expect(outcome.results[0]?.payload).toEqual({ relativePath: LOCATOR.relativePath, git: hit.payload?.git });
  });
});

describe("projectSearchResultPayloads — outline rows under metaOnly (hditp)", () => {
  const outlineRow: SearchResult = {
    id: "o",
    score: 1,
    payload: {
      relativePath: "lib/billing/ledger.rb",
      language: "ruby",
      content: "lib/billing/ledger.rb\n  Billing::Ledger\n  Billing::Ledger#post",
      git: { file: { commitCount: 4 } },
    },
  };

  it("keeps a file outline's text: the outline IS the metadata", () => {
    const outcome = projectSearchResultPayloads([outlineRow], undefined, {
      metaOnly: true,
      reranked: false,
      outline: true,
    });

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: "lib/billing/ledger.rb",
      language: "ruby",
      content: "lib/billing/ledger.rb\n  Billing::Ledger\n  Billing::Ledger#post",
    });
  });
});

// ---------------------------------------------------------------------------
// Search tools' default fields (bd tea-rags-mcp-q1g6s.16)
//
// semantic_search / hybrid_search / rank_chunks / find_similar: `fields` absent
// → the mode's default constant, whatever the rerank. chunkType, language and
// navigation leave the row; preset signals ride on rankingOverlay. find_symbol
// (no `searchTool` flag) keeps its own lean default, pinned above.
// ---------------------------------------------------------------------------

describe("projectSearchResultPayloads — search tools' default fields (q1g6s.16)", () => {
  const SEARCH = { searchTool: true } as const;

  it("exports one default per mode", () => {
    expect(DEFAULT_SEARCH_FIELDS).toEqual(["relativePath", "symbolId", "startLine", "endLine", "content"]);
    expect(DEFAULT_META_ONLY_FIELDS).toEqual(["relativePath", "symbolId", "startLine", "endLine", "signature"]);
  });

  it("narrows a metaOnly search row to DEFAULT_META_ONLY_FIELDS", () => {
    const outcome = projectSearchResultPayloads([makeFullHit()], undefined, {
      metaOnly: true,
      reranked: false,
      ...SEARCH,
    });

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: LOCATOR.relativePath,
      symbolId: LOCATOR.symbolId,
      startLine: LOCATOR.startLine,
      endLine: LOCATOR.endLine,
      signature: LOCATOR.signature,
    });
  });

  // bd tea-rags-mcp-d9w4o: a ticket drill sees the ids its taskId filter matched without a re-search.
  it("keeps the filtered level's taskIds on a metaOnly row of a taskId search", () => {
    const outcome = projectSearchResultPayloads([makeFullHit()], undefined, {
      metaOnly: true,
      reranked: false,
      taskIdsLevel: "chunk",
      ...SEARCH,
    });

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: LOCATOR.relativePath,
      symbolId: LOCATOR.symbolId,
      startLine: LOCATOR.startLine,
      endLine: LOCATOR.endLine,
      signature: LOCATOR.signature,
      git: { chunk: { taskIds: ["tea-rags-mcp-b"] } },
    });
  });

  it("keeps the file level's taskIds on a content row of a file-level taskId search", () => {
    const outcome = projectSearchResultPayloads([makeFullHit()], undefined, {
      metaOnly: false,
      reranked: false,
      taskIdsLevel: "file",
      ...SEARCH,
    });

    expect(outcome.results[0]?.payload?.git).toEqual({ file: { taskIds: ["tea-rags-mcp-a"] } });
  });

  it("narrows a content search row to DEFAULT_SEARCH_FIELDS — no navigation, chunkType, language", () => {
    const hit = makeFullHit();
    const outcome = projectSearchResultPayloads([hit], undefined, { metaOnly: false, reranked: false, ...SEARCH });

    expect(outcome.results[0]?.payload).toEqual({
      relativePath: LOCATOR.relativePath,
      symbolId: LOCATOR.symbolId,
      startLine: LOCATOR.startLine,
      endLine: LOCATOR.endLine,
      content: hit.payload?.content,
    });
  });

  it("keeps a reranked content search row lean too; its labels stay on rankingOverlay", () => {
    const overlay = { preset: "techDebt", file: { commitCount: { value: 12, label: "high" } } };
    const outcome = projectSearchResultPayloads([makeFullHit({ rankingOverlay: overlay })], undefined, {
      metaOnly: false,
      reranked: true,
      ...SEARCH,
    });

    expect(Object.keys(outcome.results[0]?.payload ?? {})).toEqual([...DEFAULT_SEARCH_FIELDS]);
    expect(outcome.results[0]?.rankingOverlay).toEqual(overlay);
  });

  it("applies explicit fields on a search row with its mandatory relativePath", () => {
    const outcome = projectSearchResultPayloads([makeFullHit()], ["chunkType"], {
      metaOnly: false,
      reranked: false,
      ...SEARCH,
    });

    expect(outcome.results[0]?.payload).toEqual({ relativePath: LOCATOR.relativePath, chunkType: "function" });
  });
});
