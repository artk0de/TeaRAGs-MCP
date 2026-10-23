import { describe, expect, it } from "vitest";

import type { IndexMetrics } from "../../../../src/core/api/public/dto/metrics.js";
import type { IndexStatus, LanguageCapability } from "../../../../src/core/api/public/index.js";
import { formatSlimDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

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
    languageVersion: { policy: "unversioned", evidence: "fixture", limitations: "fixture only" },
    ast: { tier: ast, engine: "e" },
    tests: { tier: tests, detection: "d", tech: "t" },
    codegraph: { tier: codegraph, tech: "t", symbolKindRoles: { callee: new Set(), receiver: new Set() } },
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
  return {
    collection: "c",
    totalChunks: 100,
    totalFiles: 10,
    distributions: {
      totalFiles: 10,
      language,
      chunkType: {},
      documentation: { docs: 0, code: 10 },
      topAuthors: [],
      topBlameAuthors: [],
      othersCount: 0,
    },
    signals,
  };
}

function data(overrides: Partial<ProjectDigestData> = {}, status: Partial<IndexStatus> = {}): ProjectDigestData {
  return {
    path: "/repo",
    projectName: null,
    status: { isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 100, ...status },
    metrics: metrics({ typescript: 80, markdown: 20 }, ["typescript"]),
    drift: null,
    languageCapabilities: CAPS,
    ...overrides,
  };
}

const NOW = new Date("2026-05-13T00:00:00Z");

function render(d: ProjectDigestData): string {
  return formatSlimDigest(d, NOW);
}

function section(out: string): string[] {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## Language capability"));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && (l === "" || l.startsWith("## ")));
  return lines.slice(start, end < 0 ? undefined : end);
}

describe("formatSlimDigest — language capability tiers (xip6g)", () => {
  it("renders one tier line per language present in the index, in index order", () => {
    const lines = section(render(data()));
    expect(lines[0]).toBe("## Language capability — ceiling tier · realized resolve");
    expect(lines.slice(1)).toEqual([
      "typescript: ast full · tests high · codegraph moderate",
      "markdown: ast partial · tests na · codegraph none",
    ]);
  });

  it("omits languages that are not in this index", () => {
    const out = section(render(data())).join("\n");
    expect(out).not.toContain("ruby");
    expect(out).not.toContain("sql");
  });

  it("renders a typing-tiered codegraph ceiling from the descriptor's own keys", () => {
    const lines = section(render(data({ metrics: metrics({ ruby: 100 }, ["ruby"]) })));
    expect(lines).toContain("ruby: ast full · tests medium · codegraph untyped high / yard maximum / rbs/sorbet tbd");
  });

  it("pairs each language with its realized per-language resolve rate", () => {
    const lines = section(
      render(
        data(
          { metrics: metrics({ typescript: 60, ruby: 40 }, ["typescript", "ruby"]) },
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.9,
              coveredRecall: 0.9,
              callsAttempted: 100,
              callsResolved: 90,
              callsExternalSkipped: 0,
              callsUnresolvable: 0,
              callsNoInProjectDef: 0,
              callsCoreAmbiguous: 0,
              ambiguousFanout: 0,
              callsUnnarrowedTemplate: 0,
              byLanguage: [
                {
                  language: "typescript",
                  inProjectEdgeRecall: 0.987,
                  callsAttempted: 60,
                  callsResolved: 59,
                  callsExternalSkipped: 0,
                  callsUnresolvable: 0,
                  callsNoInProjectDef: 0,
                  callsCoreAmbiguous: 0,
                  callsUnnarrowedTemplate: 0,
                },
                {
                  language: "ruby",
                  inProjectEdgeRecall: 0.5,
                  callsAttempted: 40,
                  callsResolved: 20,
                  callsExternalSkipped: 0,
                  callsUnresolvable: 0,
                  callsNoInProjectDef: 0,
                  callsCoreAmbiguous: 0,
                  callsUnnarrowedTemplate: 0,
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
      render(
        data(
          {},
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.93,
              coveredRecall: 0.93,
              callsAttempted: 100,
              callsResolved: 93,
              callsExternalSkipped: 0,
              callsUnresolvable: 0,
              callsNoInProjectDef: 0,
              callsCoreAmbiguous: 0,
              ambiguousFanout: 0,
              callsUnnarrowedTemplate: 0,
            },
          },
        ),
      ),
    );
    expect(lines).toContain("typescript: ast full · tests high · codegraph moderate · resolve 0.93");
    expect(lines).toContain("markdown: ast partial · tests na · codegraph none");
  });

  // bd tea-rags-mcp-2m83f.38 — the realized rate counts model-resolved sites;
  // the static floor and the model's share ride beside it.
  it("shows the static share and the model's sites beside a rate a model raised", () => {
    const lines = section(
      render(
        data(
          { metrics: metrics({ typescript: 60, ruby: 40 }, ["typescript", "ruby"]) },
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.9,
              coveredRecall: 0.9,
              staticInProjectEdgeRecall: 0.89,
              callsResolvedByModel: 117,
              modelResolution: [{ model: "kev", threshold: 0.7, sites: 117 }],
              callsAttempted: 100,
              callsResolved: 90,
              callsExternalSkipped: 0,
              callsUnresolvable: 0,
              callsNoInProjectDef: 0,
              callsCoreAmbiguous: 0,
              ambiguousFanout: 0,
              callsUnnarrowedTemplate: 0,
              byLanguage: [
                {
                  language: "typescript",
                  inProjectEdgeRecall: 0.987,
                  callsAttempted: 60,
                  callsResolved: 59,
                  callsExternalSkipped: 0,
                  callsUnresolvable: 0,
                  callsNoInProjectDef: 0,
                  callsCoreAmbiguous: 0,
                  callsUnnarrowedTemplate: 0,
                },
                {
                  language: "ruby",
                  inProjectEdgeRecall: 0.921,
                  staticInProjectEdgeRecall: 0.913,
                  callsResolvedByModel: 117,
                  callsAttempted: 40,
                  callsResolved: 37,
                  callsExternalSkipped: 0,
                  callsUnresolvable: 0,
                  callsNoInProjectDef: 0,
                  callsCoreAmbiguous: 0,
                  callsUnnarrowedTemplate: 0,
                },
              ],
            },
          },
        ),
      ),
    );
    expect(lines).toContain("typescript: ast full · tests high · codegraph moderate · resolve 0.99");
    expect(lines).toContain(
      "ruby: ast full · tests medium · codegraph untyped high / yard maximum / rbs/sorbet tbd · " +
        "resolve 0.92 (static 0.91 · model 117 sites, kev p>=0.7)",
    );
  });

  it("shows the model's share on an unsplit rate of the single primary language", () => {
    const lines = section(
      render(
        data(
          {},
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.93,
              coveredRecall: 0.93,
              staticInProjectEdgeRecall: 0.9,
              callsResolvedByModel: 3,
              modelResolution: [{ model: "kev", sites: 3 }],
              callsAttempted: 100,
              callsResolved: 93,
              callsExternalSkipped: 0,
              callsUnresolvable: 0,
              callsNoInProjectDef: 0,
              callsCoreAmbiguous: 0,
              ambiguousFanout: 0,
              callsUnnarrowedTemplate: 0,
            },
          },
        ),
      ),
    );
    expect(lines).toContain(
      "typescript: ast full · tests high · codegraph moderate · resolve 0.93 (static 0.9 · model 3 sites, kev)",
    );
  });

  // bd tea-rags-mcp-stpvj — a null recall is "nothing scored": the marker, not a number.
  it("renders the empty-denominator marker for a language whose recall is null", () => {
    const lines = section(
      render(
        data(
          {},
          {
            codegraphResolve: {
              inProjectEdgeRecall: null,
              coveredRecall: null,
              callsAttempted: 6,
              callsResolved: 0,
              callsExternalSkipped: 6,
              callsUnresolvable: 0,
              callsNoInProjectDef: 0,
              callsCoreAmbiguous: 0,
              ambiguousFanout: 0,
              callsUnnarrowedTemplate: 0,
            },
          },
        ),
      ),
    );
    expect(lines).toContain("typescript: ast full · tests high · codegraph moderate · resolve —");
  });

  it("does not guess which language an unsplit rate belongs to when several are primary", () => {
    const lines = section(
      render(
        data(
          { metrics: metrics({ typescript: 60, ruby: 40 }, ["typescript", "ruby"]) },
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.93,
              coveredRecall: 0.93,
              callsAttempted: 1,
              callsResolved: 1,
              callsExternalSkipped: 0,
              callsUnresolvable: 0,
              callsNoInProjectDef: 0,
              callsCoreAmbiguous: 0,
              ambiguousFanout: 0,
              callsUnnarrowedTemplate: 0,
            },
          },
        ),
      ),
    );
    expect(lines.join("\n")).not.toContain("resolve 0.93");
  });

  it("never pairs a resolve rate with a language that has no call graph", () => {
    const lines = section(
      render(
        data(
          { metrics: metrics({ markdown: 90, typescript: 10 }, ["markdown"]) },
          {
            codegraphResolve: {
              inProjectEdgeRecall: 0.93,
              coveredRecall: 0.93,
              callsAttempted: 1,
              callsResolved: 1,
              callsExternalSkipped: 0,
              callsUnresolvable: 0,
              callsNoInProjectDef: 0,
              callsCoreAmbiguous: 0,
              ambiguousFanout: 0,
              callsUnnarrowedTemplate: 0,
            },
          },
        ),
      ),
    );
    expect(lines).toContain("markdown: ast partial · tests na · codegraph none");
    expect(lines.join("\n")).not.toContain("resolve 0.93");
  });

  it("collapses languages with identical tiers and no measured rate into one line", () => {
    const lines = section(render(data({ metrics: metrics({ typescript: 80, sql: 10, kotlin: 5, jsonc: 5 }) })));
    expect(lines).toContain("sql, jsonc: ast none · tests na · codegraph none");
    // No descriptor supplied for kotlin → nothing to state about it.
    expect(lines.join("\n")).not.toContain("kotlin");
  });

  it("renders no section when the capability map is absent", () => {
    expect(section(render(data({ languageCapabilities: undefined })))).toEqual([]);
  });

  it("renders no section when the index is not indexed", () => {
    const out = render(data({}, { isIndexed: false, status: "not_indexed" }));
    expect(section(out)).toEqual([]);
  });
});
