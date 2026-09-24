import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { PrimeData } from "../../../src/cli/prime/types.js";
import type { IndexMetrics } from "../../../src/core/api/public/dto/metrics.js";
import type { IndexStatus, LanguageCapability } from "../../../src/core/api/public/index.js";

// Fixture tiers, deliberately NOT the shipped ones: the digest must render
// whatever the descriptors say, so a tier moving in a `<lang>/capability.ts`
// never breaks this suite.
function cap(
  language: string,
  ast: LanguageCapability["ast"]["tier"],
  tests: LanguageCapability["tests"]["tier"],
  codegraph: LanguageCapability["codegraph"]["tier"],
): LanguageCapability {
  return {
    language,
    ast: { tier: ast, engine: "e" },
    tests: { tier: tests, detection: "d", tech: "t" },
    codegraph: { tier: codegraph, tech: "t" },
    versions: { chunking: 1, walker: 1, codegraphSchema: 1 },
  };
}

const CAPS = new Map<string, LanguageCapability>([
  ["typescript", cap("typescript", "full", "high", "moderate")],
  ["ruby", cap("ruby", "full", "medium", { untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" })],
  ["markdown", cap("markdown", "partial", "na", "none")],
  ["sql", cap("sql", "none", "na", "none")],
  ["jsonc", cap("jsonc", "none", "na", "none")],
]);

function metrics(language: Record<string, number>, primaries: string[] = []): IndexMetrics {
  const signals: IndexMetrics["signals"] = {};
  for (const p of primaries) {
    signals[p] = {
      "git.file.commitCount": { source: { min: 1, max: 9, count: 10, labelMap: { low: 1, high: 5 } } },
    };
  }
  return { collection: "c", totalChunks: 100, totalFiles: 10, distributions: { language }, signals };
}

function data(overrides: Partial<PrimeData> = {}, status: Partial<IndexStatus> = {}): PrimeData {
  return {
    path: "/repo",
    projectName: null,
    status: { isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 100, ...status },
    metrics: metrics({ typescript: 80, markdown: 20 }, ["typescript"]),
    drift: null,
    update: null,
    languageCapabilities: CAPS,
    ...overrides,
  };
}

function section(out: string): string[] {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## Language capability"));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && (l === "" || l.startsWith("## ")));
  return lines.slice(start, end < 0 ? undefined : end);
}

describe("formatPrime — language capability tiers (xip6g)", () => {
  it("renders one tier line per language present in the index, in index order", () => {
    const lines = section(formatPrime(data()));
    expect(lines[0]).toBe("## Language capability — ceiling tier · realized resolve");
    expect(lines.slice(1)).toEqual([
      "typescript: ast full · tests high · codegraph moderate",
      "markdown: ast partial · tests na · codegraph none",
    ]);
  });

  it("omits languages that are not in this index", () => {
    const out = section(formatPrime(data())).join("\n");
    expect(out).not.toContain("ruby");
    expect(out).not.toContain("sql");
  });

  it("renders a typing-tiered codegraph ceiling from the descriptor's own keys", () => {
    const lines = section(formatPrime(data({ metrics: metrics({ ruby: 100 }, ["ruby"]) })));
    expect(lines).toContain("ruby: ast full · tests medium · codegraph untyped high / yard maximum / rbs/sorbet tbd");
  });

  it("pairs each language with its realized per-language resolve rate", () => {
    const lines = section(
      formatPrime(
        data(
          { metrics: metrics({ typescript: 60, ruby: 40 }, ["typescript", "ruby"]) },
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.9,
              callsAttempted: 100,
              callsResolved: 90,
              callsExternalSkipped: 0,
              byLanguage: [
                {
                  language: "typescript",
                  inProjectEdgeRecall: 0.987,
                  callsAttempted: 60,
                  callsResolved: 59,
                  callsExternalSkipped: 0,
                },
                {
                  language: "ruby",
                  inProjectEdgeRecall: 0.5,
                  callsAttempted: 40,
                  callsResolved: 20,
                  callsExternalSkipped: 0,
                },
              ],
            },
          },
        ),
      ),
    );
    expect(lines).toContain("typescript: ast full · tests high · codegraph moderate · resolve 0.99");
    expect(lines).toContain(
      "ruby: ast full · tests medium · codegraph untyped high / yard maximum / rbs/sorbet tbd · resolve 0.5",
    );
  });

  it("assigns an unsplit resolve rate to the single primary language", () => {
    const lines = section(
      formatPrime(
        data(
          {},
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.93,
              callsAttempted: 100,
              callsResolved: 93,
              callsExternalSkipped: 0,
            },
          },
        ),
      ),
    );
    expect(lines).toContain("typescript: ast full · tests high · codegraph moderate · resolve 0.93");
    expect(lines).toContain("markdown: ast partial · tests na · codegraph none");
  });

  // bd tea-rags-mcp-stpvj — a null recall is "nothing scored": the marker, not a number.
  it("renders the empty-denominator marker for a language whose recall is null", () => {
    const lines = section(
      formatPrime(
        data(
          {},
          {
            codegraphResolve: {
              inProjectEdgeRecall: null,
              callsAttempted: 6,
              callsResolved: 0,
              callsExternalSkipped: 6,
            },
          },
        ),
      ),
    );
    expect(lines).toContain("typescript: ast full · tests high · codegraph moderate · resolve —");
  });

  it("does not guess which language an unsplit rate belongs to when several are primary", () => {
    const lines = section(
      formatPrime(
        data(
          { metrics: metrics({ typescript: 60, ruby: 40 }, ["typescript", "ruby"]) },
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.93,
              callsAttempted: 1,
              callsResolved: 1,
              callsExternalSkipped: 0,
            },
          },
        ),
      ),
    );
    expect(lines.join("\n")).not.toContain("resolve 0.93");
  });

  it("never pairs a resolve rate with a language that has no call graph", () => {
    const lines = section(
      formatPrime(
        data(
          { metrics: metrics({ markdown: 90, typescript: 10 }, ["markdown"]) },
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.93,
              callsAttempted: 1,
              callsResolved: 1,
              callsExternalSkipped: 0,
            },
          },
        ),
      ),
    );
    expect(lines).toContain("markdown: ast partial · tests na · codegraph none");
    expect(lines.join("\n")).not.toContain("resolve 0.93");
  });

  it("collapses languages with identical tiers and no measured rate into one line", () => {
    const lines = section(formatPrime(data({ metrics: metrics({ typescript: 80, sql: 10, kotlin: 5, jsonc: 5 }) })));
    expect(lines).toContain("sql, jsonc: ast none · tests na · codegraph none");
    // No descriptor supplied for kotlin → nothing to state about it.
    expect(lines.join("\n")).not.toContain("kotlin");
  });

  it("renders no section when the capability map is absent", () => {
    expect(section(formatPrime(data({ languageCapabilities: undefined })))).toEqual([]);
  });

  it("renders no section when the index is not indexed", () => {
    const out = formatPrime(data({}, { isIndexed: false, status: "not_indexed" }));
    expect(section(out)).toEqual([]);
  });
});
