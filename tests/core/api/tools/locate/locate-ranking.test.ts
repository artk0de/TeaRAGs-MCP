import { describe, expect, it } from "vitest";

import {
  classifySiblingRows,
  diminishingReturns,
  directorySimilarity,
  diversifyByPath,
  edgeSelectivity,
  extractIdentifiers,
  identifierTokens,
  isTestPath,
  mergeLocateFiles,
  nonSelectiveIdentifiers,
  rankSeeds,
  selectHop2Sources,
  selectIdentifiers,
  shortSymbolId,
  structuralScore,
  topFilesPerDirectory,
  type LocateStructuralHit,
} from "../../../../../src/core/api/tools/locate/locate-ranking.js";

describe("locate ranking", () => {
  it("selectIdentifiers drops seed namespace segments and marks seed-defined method names as pivots", () => {
    const seeds = rankSeeds([
      [
        {
          relativePath: "app/forms/date_form.rb",
          symbolId: "TaxPreparation::Forms::DateForm#assign_value_for_date_placeholders",
          content: "TaxPreparation::Forms TaxPreparation client_timezone_offset",
        },
        {
          relativePath: "app/b.rb",
          symbolId: "TaxPreparation::Other",
          content: "TaxPreparation client_timezone_offset",
        },
      ],
    ]);
    const { identifiers, pivots } = selectIdentifiers(seeds);
    expect(identifiers[0]).toBe("assign_value_for_date_placeholders");
    expect(identifiers).toContain("client_timezone_offset");
    expect(identifiers).not.toContain("TaxPreparation");
    expect(identifiers).not.toContain("TaxPreparation::Forms");
    expect([...pivots]).toEqual(["assign_value_for_date_placeholders"]);
  });

  it("nonSelectiveIdentifiers flags identifiers spread over ≥8 files with no same-name definition", () => {
    const spread = Array.from({ length: 8 }, (_, i) => ({
      identifier: "date_format",
      relation: "sharesIdentifier" as const,
      row: { relativePath: `app/f${i}.rb` },
    }));
    const defined = spread.map((hit) => ({ ...hit, identifier: "assign_x" }));
    defined[0] = { identifier: "assign_x", relation: "sharesIdentifier", row: { relativePath: "app/z.rb" } };
    const withDefinition = [
      ...defined,
      { identifier: "assign_x", relation: "definesSame" as const, row: { relativePath: "app/q.rb" } },
    ];
    expect([...nonSelectiveIdentifiers([...spread, ...withDefinition])]).toEqual(["date_format"]);
  });

  it("shortSymbolId keeps the last two name segments", () => {
    expect(shortSymbolId("TaxPreparation::Forms::DateForm#assign")).toBe("DateForm#assign");
    expect(shortSymbolId("Foo.bar")).toBe("Foo.bar");
    expect(shortSymbolId("Solo")).toBe("Solo");
  });

  it("rankSeeds unions by symbolId (part suffix stripped) and fuses reciprocal ranks", () => {
    const seeds = rankSeeds([
      [
        { relativePath: "a.rb", symbolId: "A#run#part2" },
        { relativePath: "b.rb", symbolId: "B#go" },
      ],
      [
        { relativePath: "b.rb", symbolId: "B#go", content: "def go" },
        { relativePath: "a.rb", symbolId: "A#run" },
      ],
    ]);
    expect(seeds.map((seed) => seed.key)).toHaveLength(2);
    expect(seeds[0]?.rank).toBe(1);
    expect(seeds.find((seed) => seed.key === "B#go")?.content).toBe("def go");
    expect(seeds.find((seed) => seed.key === "A#run")).toBeDefined();
  });

  it("identifierTokens keeps snake_case, CamelCase and A::B constants; drops stoplisted ones", () => {
    const tokens = identifierTokens(
      "class Forms::DateForm < ApplicationRecord\n  def assign_value_for_date_placeholders(client_timezone_offset)\n" +
        "    attr_accessor :x\n    TimezoneHelper.call\n  end",
    );
    expect(tokens).toContain("Forms::DateForm");
    expect(tokens).toContain("assign_value_for_date_placeholders");
    expect(tokens).toContain("client_timezone_offset");
    expect(tokens).toContain("TimezoneHelper");
    expect(tokens).not.toContain("attr_accessor");
    expect(tokens).not.toContain("ApplicationRecord");
  });

  it("extractIdentifiers ranks names shared by seeds and seed-defining names first", () => {
    const seeds = rankSeeds([
      [
        { relativePath: "a.rb", symbolId: "A#assign_value_for_date_placeholders", content: "client_timezone_offset" },
        { relativePath: "b.rb", symbolId: "B#perform", content: "client_timezone_offset; other_local_name" },
      ],
    ]);
    const identifiers = extractIdentifiers(seeds, { keep: 2 });
    expect(identifiers).toEqual(["assign_value_for_date_placeholders", "client_timezone_offset"]);
  });

  it("classifySiblingRows marks same-named definitions definesSame and usages sharesIdentifier", () => {
    const hits = classifySiblingRows("assign_value", [
      { relativePath: "x.rb", symbolId: "X#assign_value" },
      { relativePath: "y.rb", symbolId: "Y#run", content: "assign_value(1)" },
      { relativePath: "z.rb", symbolId: "Z#run", content: "unrelated" },
    ]);
    expect(hits.map((hit) => [hit.row.relativePath, hit.relation])).toEqual([
      ["x.rb", "definesSame"],
      ["y.rb", "sharesIdentifier"],
    ]);
  });

  it("mergeLocateFiles sums weights per file, excludes tests, caps the list", () => {
    const seeds = rankSeeds([[{ relativePath: "app/a.rb", symbolId: "A#run", content: "def run" }]]);
    const { files, truncated } = mergeLocateFiles({
      seeds,
      siblings: [
        { identifier: "run_x", relation: "definesSame", row: { relativePath: "app/b.rb", symbolId: "B#run_x" } },
        { identifier: "run_x", relation: "sharesIdentifier", row: { relativePath: "app/c.rb", content: "run_x" } },
        { identifier: "run_x", relation: "definesSame", row: { relativePath: "spec/b_spec.rb", symbolId: "S#run_x" } },
      ],
      callers: [{ seedSymbol: "A#run", relativePath: "app/d.rb", symbolId: "D#call", callExpression: "A.new.run" }],
      identifiers: ["run_x"],
      maxFiles: 3,
    });
    expect(files.map((file) => file.relativePath)).toEqual(["app/a.rb", "app/b.rb", "app/d.rb"]);
    expect(files[1]?.via).toEqual(["definesSame:run_x"]);
    expect(files[2]?.line).toBe("A.new.run");
    expect(truncated).toBe(true);
    expect(isTestPath("spec/b_spec.rb")).toBe(true);
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("app/models/test_case.rb")).toBe(false);
  });

  it("topFilesPerDirectory spreads expansion sources over directories and skips tests", () => {
    const ranked = ["a/x.rb", "a/y.rb", "a/z.rb", "spec/a_spec.rb", "b/x.rb", "c/x.rb"];
    expect(topFilesPerDirectory(ranked, 3, 2)).toEqual(["a/x.rb", "a/y.rb", "b/x.rb"]);
  });

  it("edgeSelectivity is 1 for short edge lists and decays for hubs", () => {
    expect(edgeSelectivity(3)).toBe(1);
    expect(edgeSelectivity(10)).toBe(1);
    expect(edgeSelectivity(40)).toBe(0.25);
  });

  it("structuralScore counts each source file once, prefers hop 1 and rewards convergence", () => {
    const hit = (fromFile: string, hop: 1 | 2): LocateStructuralHit => ({
      relativePath: "t.rb",
      fromFile,
      hop,
      direction: "importedBy",
      selectivity: 1,
    });
    const single = structuralScore([hit("a.rb", 1), hit("a.rb", 2)]);
    const hop2Only = structuralScore([hit("a.rb", 2)]);
    const converged = structuralScore([hit("a.rb", 1), hit("b.rb", 1)]);
    expect(single).toBeGreaterThan(hop2Only);
    expect(converged).toBeGreaterThan(2 * single);
  });

  it("selectHop2Sources prefers already-scored or convergent neighbours and never re-expands sources", () => {
    const hit = (relativePath: string, fromFile: string, selectivity = 1): LocateStructuralHit => ({
      relativePath,
      fromFile,
      hop: 1,
      direction: "importedBy",
      selectivity,
    });
    const hop1 = [
      hit("lone.rb", "s1.rb"),
      hit("shared.rb", "s1.rb", 0.2),
      hit("shared.rb", "s2.rb", 0.2),
      hit("scored.rb", "s2.rb", 0.1),
      hit("s2.rb", "s1.rb"),
    ];
    const picked = selectHop2Sources(hop1, {
      scored: new Set(["scored.rb"]),
      exclude: new Set(["s1.rb", "s2.rb"]),
      max: 2,
    });
    expect(picked).toEqual(["shared.rb", "scored.rb"]);
  });

  it("diminishingReturns weighs the k-th distinct target of one source 1/k", () => {
    const damping = diminishingReturns([
      ["s", "a"],
      ["s", "b"],
      ["s", "a"],
      ["t", "c"],
      ["s", "c"],
    ]);
    expect(damping.get("s\0a")).toBe(1);
    expect(damping.get("s\0b")).toBe(0.5);
    expect(damping.get("s\0c")).toBeCloseTo(1 / 3);
    expect(damping.get("t\0c")).toBe(1);
  });

  it("mergeLocateFiles damps the tail of files reached only through one broad caller source", () => {
    const callers = ["a.rb", "b.rb", "c.rb"].map((relativePath) => ({
      seedSymbol: "Helper#fmt",
      relativePath,
      symbolId: `${relativePath}#x`,
      callExpression: "fmt",
    }));
    const { files } = mergeLocateFiles({
      seeds: [],
      siblings: [],
      callers,
      identifiers: [],
      maxFiles: 5,
      pathDiversity: 0,
    });
    expect(files.map((file) => file.score)).toEqual([0.6, 0.3, 0.2]);
  });

  it("mergeLocateFiles emits a compact row: one short symbol, at most 3 via, line ≤ 80 chars", () => {
    const siblings = ["alpha_one", "beta_two", "gamma_three", "delta_four"].map((identifier) => ({
      identifier,
      relation: "sharesIdentifier" as const,
      row: { relativePath: "a.rb", symbolId: "A::B::C#run", content: `${identifier} ${"x".repeat(200)}` },
    }));
    const { files } = mergeLocateFiles({ seeds: [], siblings, callers: [], identifiers: [], maxFiles: 5 });
    expect(files[0]?.symbol).toBe("C#run");
    expect(files[0]?.via).toHaveLength(3);
    expect(files[0]?.line.length).toBeLessThanOrEqual(80);
  });

  it("directorySimilarity is the shared leading directory share of the deeper path", () => {
    expect(directorySimilarity("a/b/c/x.rb", "a/b/c/y.rb")).toBe(1);
    expect(directorySimilarity("a/b/c/x.rb", "a/b/d/y.rb")).toBeCloseTo(2 / 3);
    expect(directorySimilarity("a/x.rb", "b/y.rb")).toBe(0);
  });

  it("diversifyByPath lets a lower-scored file from another module past a flooding module", () => {
    const ranked = [
      { relativePath: "m/x/a.rb", score: 3 },
      { relativePath: "m/x/b.rb", score: 2.8 },
      { relativePath: "n/c.rb", score: 2.2 },
    ];
    expect(diversifyByPath(ranked, 2, 0.4).map((file) => file.relativePath)).toEqual(["m/x/a.rb", "n/c.rb"]);
    expect(diversifyByPath(ranked, 2, 0).map((file) => file.relativePath)).toEqual(["m/x/a.rb", "m/x/b.rb"]);
  });

  it("mergeLocateFiles ranks a file reached structurally from found files", () => {
    const { files } = mergeLocateFiles({
      seeds: rankSeeds([[{ relativePath: "a.rb", symbolId: "A#run", content: "run" }]]),
      siblings: [],
      callers: [],
      structural: [
        { relativePath: "b.rb", fromFile: "a.rb", hop: 1, direction: "importedBy", selectivity: 1 },
        { relativePath: "a.rb", fromFile: "a.rb", hop: 1, direction: "imports", selectivity: 1 },
      ],
      identifiers: [],
      maxFiles: 5,
    });
    expect(files.map((file) => file.relativePath)).toEqual(["a.rb", "b.rb"]);
    expect(files[1]?.via).toEqual(["importedBy:a.rb"]);
  });
});
