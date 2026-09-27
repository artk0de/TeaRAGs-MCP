import { describe, expect, it } from "vitest";

import {
  classifyAlternative,
  classifyRename,
  deprecatedTerms,
  extractRenamePairs,
  firstDeclarationTimes,
  parseNamingLexiconOutput,
  renameWordDiff,
  sampleControlTypes,
  scanTypeDeclarations,
  scoreNamingOutcome,
  tallyScoredItems,
  type ScoredEvalItem,
} from "../../scripts/lib/naming-rename-eval.js";

describe("extractRenamePairs", () => {
  it("reads unicode and ascii arrows, with or without backticks", () => {
    const message = [
      "refactor: rename ThreadPool → WorkerDispatchPool",
      "",
      "- `GitFileMetadata` -> `GitFileSignals`",
      "- ChunkChurnInfo→ChunkChurnOverlay",
    ].join("\n");
    expect(extractRenamePairs(message)).toEqual([
      { oldName: "ThreadPool", newName: "WorkerDispatchPool" },
      { oldName: "GitFileMetadata", newName: "GitFileSignals" },
      { oldName: "ChunkChurnInfo", newName: "ChunkChurnOverlay" },
    ]);
  });

  it("reads rename-verb phrasings", () => {
    const message = [
      "rename RubyBodyGrouper to RubyClassBodyChunker",
      "Renamed `SearchFacade` into `ExploreFacade`.",
      "LanguageFactoryImpl renamed to LanguageFactory",
      "RubyTypeRef becomes TypeRef",
    ].join("\n");
    expect(extractRenamePairs(message)).toEqual([
      { oldName: "RubyBodyGrouper", newName: "RubyClassBodyChunker" },
      { oldName: "SearchFacade", newName: "ExploreFacade" },
      { oldName: "LanguageFactoryImpl", newName: "LanguageFactory" },
      { oldName: "RubyTypeRef", newName: "TypeRef" },
    ]);
  });

  it("ignores lowercase identifiers, identical names and method arrows", () => {
    const message = [
      "buildMetadata → buildFileSignals",
      "Doc → Doc",
      "Reranker#rerank → Reranker#score",
      "fanIn -> FanIn",
    ].join("\n");
    expect(extractRenamePairs(message)).toEqual([]);
  });

  it("reports each pair once per message", () => {
    expect(extractRenamePairs("A: FooBar → BazBar\nagain FooBar → BazBar")).toEqual([
      { oldName: "FooBar", newName: "BazBar" },
    ]);
  });
});

describe("scanTypeDeclarations", () => {
  it("finds exported, abstract and plain class/interface/type/enum declarations with their base", () => {
    const source = [
      "export abstract class BaseChunker extends Walker<Node> {",
      "interface Options {",
      "export type Mode = 'a' | 'b';",
      "export const enum Kind { A }",
      "declare class Ambient {}",
      "export class Impl implements Runner {",
      "  // the class Mentioned in a comment is not a declaration",
      "export default class Defaulted extends ns.Parent {}",
    ].join("\n");
    expect(scanTypeDeclarations(source)).toEqual([
      { name: "BaseChunker", extendsName: "Walker" },
      { name: "Options" },
      { name: "Mode" },
      { name: "Kind" },
      { name: "Ambient" },
      { name: "Impl" },
      { name: "Defaulted", extendsName: "Parent" },
    ]);
  });

  it("skips type-only specifiers inside an import or export list", () => {
    const source = [
      "import {",
      "  type SymbolDefinition,",
      "  type Other }",
      "export { type Reexported } from './x.js';",
    ].join("\n");
    expect(scanTypeDeclarations(source)).toEqual([]);
  });
});

describe("firstDeclarationTimes", () => {
  it("keeps the earliest commit time at which an added line declares each type", () => {
    const log = [
      "\u001e300",
      "diff --git a/src/a.ts b/src/a.ts",
      "+export class Alpha {",
      "-export class Gone {",
      "\u001e100",
      "+++ b/src/a.ts",
      "+export class Alpha {",
      "+interface Beta {",
      "\u001e200",
      "+type Beta = number;",
    ].join("\n");
    expect(firstDeclarationTimes(log)).toEqual(
      new Map([
        ["Alpha", 100],
        ["Beta", 100],
      ]),
    );
  });
});

describe("renameWordDiff", () => {
  it("splits both names into lowercase words and diffs them", () => {
    expect(renameWordDiff("SparseVectorRebuild", "SparseV1VectorRebuild")).toEqual({
      oldWords: ["sparse", "vector", "rebuild"],
      newWords: ["sparse", "v1", "vector", "rebuild"],
      removed: [],
      added: ["v1"],
    });
  });
});

describe("classifyRename", () => {
  it("is head when only the last word changes", () => {
    expect(classifyRename("GitFileMetadata", "GitFileSignals")).toBe("head");
  });

  it("is qualifier when the head is kept", () => {
    expect(classifyRename("ThreadPool", "WorkerDispatchPool")).toBe("qualifier");
    expect(classifyRename("SearchFacade", "ExploreFacade")).toBe("qualifier");
  });

  it("is both when head and qualifiers change", () => {
    expect(classifyRename("RubyBodyGrouper", "RubyClassBodyChunker")).toBe("both");
  });

  it("is role-added when the old head survives as a qualifier under a new head", () => {
    expect(classifyRename("PipelineBatchSize", "BatchSizeController")).toBe("role-added");
    expect(classifyRename("IndexStats", "IndexStatsReport")).toBe("role-added");
  });

  it("is both, not role-added, when the new head arrives with other new words", () => {
    expect(classifyRename("SnapshotV1ToV2", "SnapshotV2MtimeSize")).toBe("both");
  });

  it("is move when the words are the same", () => {
    expect(classifyRename("FooBar", "FooBar")).toBe("move");
  });
});

describe("classifyAlternative", () => {
  it("names a head found by meaning by its examples", () => {
    expect(
      classifyAlternative({ word: "signal", slot: "head", heads: [], domains: [], lift: 2, examples: ["X"] }),
    ).toBe("head-by-meaning");
  });

  it("names a head spelling variant", () => {
    expect(classifyAlternative({ word: "doc", slot: "head", heads: [], domains: ["a"], lift: 3 })).toBe("spelling");
  });

  it("names a path-term alternative by its replaced word and zero lift", () => {
    expect(
      classifyAlternative({ word: "freshness", heads: [], domains: ["a/freshness"], lift: 0, replaces: "staleness" }),
    ).toBe("path-word");
    expect(
      classifyAlternative({
        word: "freshness",
        slot: "head",
        heads: [],
        domains: ["a/freshness"],
        lift: 0,
        replaces: "staleness",
      }),
    ).toBe("path-word");
  });

  it("names a lifted qualifier as lexical", () => {
    expect(classifyAlternative({ word: "predefined", heads: ["preset"], domains: [], lift: 4, replaces: "x" })).toBe(
      "lexical",
    );
  });
});

describe("scoreNamingOutcome", () => {
  const pair = { oldName: "GitFileMetadata", newName: "GitFileSignals" };

  it("catches an alternative equal to a new word, singular or plural", () => {
    const scored = scoreNamingOutcome(
      {
        verdict: "CONFORMS",
        alternatives: [{ word: "signal", slot: "head", heads: [], domains: [], lift: 1, examples: ["S"] }],
      },
      pair,
    );
    expect(scored).toEqual({ outcome: "CONFORMS+alt", score: "caught", mechanisms: ["head-by-meaning"] });
  });

  it("flags-other an alternative that does not point toward the new name", () => {
    const scored = scoreNamingOutcome(
      {
        verdict: "NEW_TERM",
        alternatives: [{ word: "payload", slot: "head", heads: [], domains: [], lift: 1 }],
      },
      pair,
    );
    expect(scored).toEqual({ outcome: "NEW_TERM+alt", score: "flagged-other", mechanisms: ["spelling"] });
  });

  it("catches a MISFIT whose role word is one of the new words", () => {
    const scored = scoreNamingOutcome(
      {
        verdict: "MISFIT",
        suggestion: "PipelineBatchSizeController",
        role: { word: "controller", evidence: "directory", examples: [] },
      },
      { oldName: "PipelineBatchSize", newName: "BatchSizeController" },
    );
    expect(scored).toEqual({ outcome: "MISFIT", score: "caught", mechanisms: ["role:directory"] });
  });

  it("flags-other a MISFIT whose suggestion misses the new words", () => {
    const scored = scoreNamingOutcome(
      {
        verdict: "MISFIT",
        suggestion: "GitFileMetadataProvider",
        role: { word: "provider", evidence: "inheritance", examples: [] },
      },
      pair,
    );
    expect(scored).toEqual({ outcome: "MISFIT", score: "flagged-other", mechanisms: ["role:inheritance"] });
  });

  it("flags-other a collision and a bare NEW_TERM", () => {
    expect(scoreNamingOutcome({ verdict: "COLLISION", existing: { symbolId: "X", relPath: "x.ts" } }, pair)).toEqual({
      outcome: "COLLISION",
      score: "flagged-other",
      mechanisms: ["collision"],
    });
    expect(scoreNamingOutcome({ verdict: "NEW_TERM", topTerms: [] }, pair)).toEqual({
      outcome: "NEW_TERM",
      score: "flagged-other",
      mechanisms: ["new-term"],
    });
  });

  it("is silent on a bare CONFORMS", () => {
    expect(scoreNamingOutcome({ verdict: "CONFORMS" }, pair)).toEqual({
      outcome: "CONFORMS",
      score: "silent",
      mechanisms: [],
    });
  });

  it("scores a control (no new name) as a false flag on MISFIT or any alternative", () => {
    expect(
      scoreNamingOutcome({ verdict: "CONFORMS", alternatives: [{ word: "x", heads: ["h"], domains: [], lift: 2 }] }),
    ).toEqual({ outcome: "CONFORMS+alt", score: "false-flag", mechanisms: ["lexical"] });
    expect(scoreNamingOutcome({ verdict: "NEW_TERM", topTerms: [] })).toEqual({
      outcome: "NEW_TERM",
      score: "clean",
      mechanisms: [],
    });
  });
});

describe("tallyScoredItems", () => {
  const item = (group: string, score: ScoredEvalItem["score"], mechanisms: string[] = []): ScoredEvalItem => ({
    group,
    outcome: "CONFORMS",
    score,
    mechanisms,
  });

  it("counts scores per group and fired mechanisms per score", () => {
    const tally = tallyScoredItems([
      item("head", "caught", ["head-by-meaning"]),
      item("head", "silent"),
      item("qualifier", "flagged-other", ["lexical", "path-word"]),
    ]);
    expect(tally.byGroup).toEqual({
      head: { total: 2, caught: 1, "flagged-other": 0, silent: 1, "false-flag": 0, clean: 0 },
      qualifier: { total: 1, caught: 0, "flagged-other": 1, silent: 0, "false-flag": 0, clean: 0 },
    });
    expect(tally.byMechanism).toEqual({
      "head-by-meaning": { caught: 1 },
      lexical: { "flagged-other": 1 },
      "path-word": { "flagged-other": 1 },
    });
  });
});

describe("deprecatedTerms", () => {
  it("counts the words renamed away from, per slot, with what replaced them", () => {
    expect(
      deprecatedTerms([
        { oldName: "GitFileMetadata", newName: "GitFileSignals" },
        { oldName: "ChunkMetadata", newName: "ChunkSignals" },
        { oldName: "SearchFacade", newName: "ExploreFacade" },
        { oldName: "IngestFacade", newName: "IndexingOps" },
      ]),
    ).toEqual([
      { word: "metadata", slot: "head", count: 2, replacedBy: { signals: 2 } },
      { word: "facade", slot: "head", count: 1, replacedBy: { ops: 1 } },
      { word: "ingest", slot: "qualifier", count: 1, replacedBy: { indexing: 1 } },
      { word: "search", slot: "qualifier", count: 1, replacedBy: { explore: 1 } },
    ]);
  });
});

describe("sampleControlTypes", () => {
  const candidates = Array.from({ length: 30 }, (_, i) => `Type${String(i).padStart(2, "0")}`);

  it("draws the same sample for the same seed, sorted", () => {
    const a = sampleControlTypes(candidates, 5, 7);
    expect(a).toEqual(sampleControlTypes([...candidates].reverse(), 5, 7));
    expect(a).toHaveLength(5);
    expect([...a].sort()).toEqual(a);
  });

  it("returns the whole pool when it is smaller than the sample", () => {
    expect(sampleControlTypes(["B", "A"], 5, 1)).toEqual(["A", "B"]);
  });
});

describe("parseNamingLexiconOutput", () => {
  it("strips the CLI's [tea-rags] lines and returns the verdicts and notices", () => {
    const stdout = [
      "[tea-rags] Attached to Qdrant daemon (pid=1, port=2, refs=3)",
      JSON.stringify({ scope: "", names: [{ name: "Foo", verdict: "CONFORMS" }] }, null, 2),
      "[tea-rags] Released Qdrant ref (remaining=2)",
    ].join("\n");
    expect(parseNamingLexiconOutput(stdout)).toEqual({
      names: [{ name: "Foo", verdict: "CONFORMS" }],
      notices: [],
    });
  });

  it("surfaces a skipped alignment notice, which voids the batch", () => {
    const stdout = JSON.stringify({ names: [], notices: ["type-name alignment skipped: fetch failed"] });
    expect(parseNamingLexiconOutput(stdout).notices).toEqual(["type-name alignment skipped: fetch failed"]);
  });
});
