/**
 * Why a hybrid_search / semantic_search answer came back empty (agent turn
 * economy N6, bd tea-rags-mcp-wrosj). Diagnosed in a fixed order, each step a
 * count over the index:
 *
 * 1. `pathPattern` alone matches no point → `pathPatternMatchesNothing`, with
 *    the nearest existing literal directory prefix as the suggestion;
 * 2. points exist without the caller's filters / the preset default →
 *    `filteredOut`, naming what to drop (`filter: {}` for a filter);
 * 3. otherwise → `noMatch`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  explainEmptySearch,
  type EmptySearchCounter,
} from "../../../../../src/core/api/internal/ops/empty-search-explanation.js";

/** Index fixture: the relativePaths of its points. The path pre-filter is a prefix token, the glob is exact. */
const INDEXED = ["src/core/api/app.ts", "src/core/api/tools/explore.ts", "src/core/domains/x.ts", "tests/a.test.ts"];

const pathFilter = (pattern: string) => {
  const token = pattern.replace(/\*.*$/, "");
  return token === "" ? undefined : { must: [{ key: "relativePath", match: { text: token } }] };
};

function counter(points: string[] = INDEXED) {
  const tokenOf = (filter: Record<string, unknown> | undefined) =>
    (filter?.must as { match: { text: string } }[] | undefined)?.[0]?.match.text ?? "";
  const fake: EmptySearchCounter = {
    count: vi.fn(async (filter) => points.filter((p) => p.includes(tokenOf(filter))).length),
    samplePaths: vi.fn(async (filter, limit) => points.filter((p) => p.includes(tokenOf(filter))).slice(0, limit)),
  };
  return fake;
}

describe("explainEmptySearch", () => {
  it("pathPattern whose pre-filter matches no point → pathPatternMatchesNothing with the nearest existing prefix", async () => {
    const result = await explainEmptySearch(counter(), {
      pathPattern: "src/core/api/missing/**",
      pathFilter,
      narrowingParams: [],
    });

    expect(result.reason).toBe("pathPatternMatchesNothing");
    expect(result.message).toMatch(/src\/core\/api\/missing\/\*\*/);
    expect(result.suggestions).toEqual(["src/core/api/**"]);
  });

  it("pathPattern whose pre-filter superset holds points but none the glob matches → pathPatternMatchesNothing", async () => {
    const result = await explainEmptySearch(counter(), {
      pathPattern: "src/core/api/**/*.rb",
      pathFilter,
      narrowingParams: [],
    });

    expect(result.reason).toBe("pathPatternMatchesNothing");
    expect(result.suggestions).toEqual(["src/core/api/**"]);
  });

  it("pathPattern with matches, filters removed them → filteredOut naming filter: {} and the typed param", async () => {
    const result = await explainEmptySearch(counter(), {
      pathPattern: "src/core/**",
      pathFilter,
      narrowingParams: ["filter", "language"],
    });

    expect(result.reason).toBe("filteredOut");
    expect(result.suggestions).toEqual(["filter: {}", "language"]);
    expect(result.message).toMatch(/filter/);
  });

  it("a preset DEFAULT filter that removed every match → filteredOut naming the preset and its clearWith", async () => {
    const result = await explainEmptySearch(counter(), {
      pathFilter,
      narrowingParams: [],
      presetFilterNotice: { preset: "techDebt", by: "production (isTest)", clearWith: "filter: {}" },
    });

    expect(result.reason).toBe("filteredOut");
    expect(result.message).toMatch(/techDebt/);
    expect(result.message).toMatch(/production \(isTest\)/);
    expect(result.suggestions).toEqual(["filter: {}"]);
  });

  it("points exist in scope and nothing narrowed → noMatch, with no filter count", async () => {
    const fake = counter();
    const result = await explainEmptySearch(fake, { pathPattern: "src/**", pathFilter, narrowingParams: [] });

    expect(result.reason).toBe("noMatch");
    expect(result.message.length).toBeGreaterThan(0);
    expect("suggestions" in result).toBe(false);
  });

  it("filters set but the scope is empty without them too → noMatch, not filteredOut", async () => {
    const result = await explainEmptySearch(counter([]), { pathFilter, narrowingParams: ["filter"] });

    expect(result.reason).toBe("noMatch");
  });
});
