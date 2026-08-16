import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCorpusExclusionFilter,
  classifyUnlocatedCallShape,
  collectSourceFiles,
  decomposeOracleMismatches,
  describeOracleDeclaration,
  diffResolution,
  findUncoveredCategories,
  findValueReference,
  flagTrackBPriorities,
  formatOracleTable,
  isScoredSource,
  reconcileOracleMissed,
  reconcileOraclePhantom,
  reconcileOracleWrongFile,
  referencesCallableValue,
  tallyBy,
  tallyChainOutput,
  tallyUnlocatedShapes,
  type OracleOutcome,
  type OracleRow,
  type OracleTargetFacts,
  type OracleVerdict,
} from "../../scripts/ts-codegraph-typechecker-oracle.js";
import type { CallRef } from "../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../src/core/domains/language/index.js";

/** One call-site row, defaulted so each test states only the axis it exercises. */
function row(overrides: Partial<OracleRow> = {}): OracleRow {
  return {
    relPath: "src/a.ts",
    startLine: 1,
    callText: "run()",
    receiverKind: "bareCall",
    categories: ["plain"],
    verdict: "match",
    chainOutput: "pinned",
    ...overrides,
  };
}

/** N rows sharing one verdict — the tally inputs read as counts, not fixtures. */
function rows(verdict: OracleVerdict, count: number, overrides: Partial<OracleRow> = {}): OracleRow[] {
  return Array.from({ length: count }, () => row({ verdict, ...overrides }));
}

/** The checker resolved the call to an in-project declaration. */
function inProject(targetRelPath: string, targetSymbolId: string | null): OracleOutcome {
  return { kind: "inProject", answer: { targetRelPath, targetSymbolId } };
}

describe("diffResolution", () => {
  it("reports match when both sides name the same file and the same symbol", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: "Repo#fetch" };

    expect(diffResolution(chain, inProject("src/repo.ts", "Repo#fetch"))).toEqual("match");
  });

  it("reports fileOnly when both sides name the same file but disagree on the symbol", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: "Repo#fetch" };

    expect(diffResolution(chain, inProject("src/repo.ts", "Cache#fetch"))).toEqual("fileOnly");
  });

  it("reports fileOnly when the file agrees and only one side pinned a symbol", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: null };

    expect(diffResolution(chain, inProject("src/repo.ts", "Repo#fetch"))).toEqual("fileOnly");
  });

  it("reports match when the file agrees and neither side pinned a symbol", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: null };

    expect(diffResolution(chain, inProject("src/repo.ts", null))).toEqual("match");
  });

  it("reports wrongFile when the two sides name different files", () => {
    const chain = { targetRelPath: "src/cache.ts", targetSymbolId: "Cache#fetch" };

    expect(diffResolution(chain, inProject("src/repo.ts", "Repo#fetch"))).toEqual("wrongFile");
  });

  it("reports missed when the type checker resolved a call the chain declined", () => {
    expect(diffResolution(null, inProject("src/repo.ts", "Repo#fetch"))).toEqual("missed");
  });

  it("reports phantom when the chain claims an in-project target the checker places outside the project", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: "Repo#map" };

    expect(diffResolution(chain, { kind: "external" })).toEqual("phantom");
  });

  it("reports agreeExternal when both sides leave an out-of-project call alone", () => {
    expect(diffResolution(null, { kind: "external" })).toEqual("agreeExternal");
  });

  it("reports chainOnly when the chain resolved a call the type checker has no answer for", () => {
    const chain = { targetRelPath: "src/repo.ts", targetSymbolId: "Repo#fetch" };

    expect(diffResolution(chain, { kind: "unknown" })).toEqual("chainOnly");
  });

  it("reports bothUnresolved when neither side has an answer", () => {
    expect(diffResolution(null, { kind: "unknown" })).toEqual("bothUnresolved");
  });
});

describe("tallyChainOutput", () => {
  it("counts every emitted edge, the file-only subset, and the declines", () => {
    const tally = tallyChainOutput([
      ...rows("match", 3, { chainOutput: "pinned" }),
      ...rows("fileOnly", 2, { chainOutput: "fileOnly" }),
      ...rows("missed", 4, { chainOutput: "none" }),
    ]);
    // fileOnly edges are a SUBSET of edges, not a sibling bucket — the -156
    // regression bd pmxuv measured was a drop in `edges`, invisible to every
    // verdict table because the checker had no opinion on those sites
    expect(tally).toEqual({ edges: 5, fileOnly: 2, unresolved: 4 });
  });

  it("counts nothing for an empty run", () => {
    expect(tallyChainOutput([])).toEqual({ edges: 0, fileOnly: 0, unresolved: 0 });
  });
});

describe("diffResolution against external ground truth (bd tea-rags-mcp-ffju3)", () => {
  it("reads a chain answer naming the same external declaration as agreement rather than a fabricated edge", () => {
    const chain = { targetRelPath: "node_modules/typescript/lib/lib.es5.d.ts", targetSymbolId: null };

    expect(diffResolution(chain, { kind: "external" })).toEqual("agreeExternal");
  });

  it("reads a chain answer naming a different external declaration as agreement, since neither side claims an in-project edge", () => {
    const chain = { targetRelPath: "node_modules/pino/lib/proto.d.ts", targetSymbolId: null };

    expect(diffResolution(chain, { kind: "external" })).toEqual("agreeExternal");
  });

  it("reads a chain answer naming a declaration file under the project's own tree as agreement", () => {
    const chain = { targetRelPath: "src/core/contracts/types/codegraph.d.ts", targetSymbolId: null };

    expect(diffResolution(chain, { kind: "external" })).toEqual("agreeExternal");
  });

  it("reads a chain answer naming the project's compiled output as agreement rather than a fabricated edge", () => {
    const chain = { targetRelPath: "build/core/runner.js", targetSymbolId: "Runner.run" };

    expect(diffResolution(chain, { kind: "external" })).toEqual("agreeExternal");
  });
});

describe("tallyBy", () => {
  it("counts every verdict bucket for a category", () => {
    const input = [
      ...rows("match", 6),
      ...rows("fileOnly", 2),
      ...rows("wrongFile", 1),
      ...rows("missed", 3),
      ...rows("phantom", 7),
      ...rows("agreeExternal", 13),
      ...rows("chainOnly", 4),
      ...rows("bothUnresolved", 5),
    ];

    const [tally] = tallyBy(input, (r) => r.categories);

    expect(tally).toEqual({
      label: "plain",
      sites: 41,
      oracle: 12,
      match: 6,
      fileOnly: 2,
      wrongFile: 1,
      missed: 3,
      external: 20,
      phantom: 7,
      agreeExternal: 13,
      chainOnly: 4,
      bothUnresolved: 5,
      mismatchRate: 4 / 12,
      phantomRate: 7 / 20,
    });
  });

  it("keeps the in-project denominator free of external, chainOnly and bothUnresolved rows", () => {
    const input = [
      ...rows("match", 1),
      ...rows("agreeExternal", 40),
      ...rows("chainOnly", 9),
      ...rows("bothUnresolved", 90),
    ];

    const [tally] = tallyBy(input, (r) => r.categories);

    expect(tally.oracle).toEqual(1);
    expect(tally.mismatchRate).toEqual(0);
  });

  it("rates phantom edges against the external ground truth rather than the in-project one", () => {
    const input = [...rows("match", 100), ...rows("phantom", 1), ...rows("agreeExternal", 3)];

    const [tally] = tallyBy(input, (r) => r.categories);

    expect(tally.external).toEqual(4);
    expect(tally.phantomRate).toEqual(0.25);
    expect(tally.mismatchRate).toEqual(0);
  });

  it("counts a multi-label row once under each of its categories", () => {
    const input = [row({ categories: ["generic", "unionNarrowing"], verdict: "missed" })];

    const tallies = tallyBy(input, (r) => r.categories);

    expect(tallies.map((t) => t.label).sort()).toEqual(["generic", "unionNarrowing"]);
    expect(tallies.every((t) => t.missed === 1 && t.mismatchRate === 1)).toEqual(true);
  });

  it("groups by receiver kind when handed the receiver-kind labeller", () => {
    const input = [
      row({ receiverKind: "bareCall", verdict: "match" }),
      row({ receiverKind: "chain", verdict: "missed" }),
      row({ receiverKind: "chain", verdict: "missed" }),
    ];

    const tallies = tallyBy(input, (r) => [r.receiverKind]);

    expect(tallies.map((t) => [t.label, t.sites])).toEqual([
      ["chain", 2],
      ["bareCall", 1],
    ]);
  });

  it("reports a zero mismatch rate when no call site in the category has a type-checker answer", () => {
    const input = rows("bothUnresolved", 7);

    const [tally] = tallyBy(input, (r) => r.categories);

    expect(tally.oracle).toEqual(0);
    expect(tally.mismatchRate).toEqual(0);
  });

  it("orders labels by call-site count descending so the widest category reads first", () => {
    const input = [
      ...rows("match", 1, { categories: ["overload"] }),
      ...rows("match", 5, { categories: ["generic"] }),
      ...rows("match", 3, { categories: ["jsx"] }),
    ];

    expect(tallyBy(input, (r) => r.categories).map((t) => t.label)).toEqual(["generic", "jsx", "overload"]);
  });
});

describe("flagTrackBPriorities", () => {
  it("flags a category whose mismatch rate clears the threshold on enough evidence", () => {
    const input = [
      ...rows("missed", 30, { categories: ["unionNarrowing"] }),
      ...rows("match", 10, { categories: ["unionNarrowing"] }),
    ];

    const flagged = flagTrackBPriorities(tallyBy(input, (r) => r.categories));

    expect(flagged.map((p) => p.label)).toEqual(["unionNarrowing"]);
    expect(flagged[0].mismatchRate).toEqual(0.75);
  });

  it("withholds a flag from a category with too few type-checker answers to trust", () => {
    const input = rows("missed", 3, { categories: ["structuralTyping"] });

    expect(flagTrackBPriorities(tallyBy(input, (r) => r.categories))).toEqual([]);
  });

  it("withholds a flag from a well-covered category the chain already agrees with", () => {
    const input = [
      ...rows("match", 99, { categories: ["generic"] }),
      ...rows("missed", 1, { categories: ["generic"] }),
    ];

    expect(flagTrackBPriorities(tallyBy(input, (r) => r.categories))).toEqual([]);
  });

  it("orders flagged categories by mismatch rate descending", () => {
    const input = [
      ...rows("missed", 10, { categories: ["a"] }),
      ...rows("match", 30, { categories: ["a"] }),
      ...rows("missed", 35, { categories: ["b"] }),
      ...rows("match", 5, { categories: ["b"] }),
    ];

    expect(flagTrackBPriorities(tallyBy(input, (r) => r.categories)).map((p) => p.label)).toEqual(["b", "a"]);
  });

  it("honours caller-supplied evidence and rate thresholds", () => {
    const input = [...rows("missed", 2, { categories: ["jsx"] }), ...rows("match", 2, { categories: ["jsx"] })];

    const flagged = flagTrackBPriorities(
      tallyBy(input, (r) => r.categories),
      { minOracle: 4, minMismatchRate: 0.5 },
    );

    expect(flagged.map((p) => p.label)).toEqual(["jsx"]);
  });
});

describe("findUncoveredCategories", () => {
  it("names the expected categories the corpus produced no call site for", () => {
    const tallies = tallyBy(rows("match", 2, { categories: ["generic"] }), (r) => r.categories);

    expect(findUncoveredCategories(tallies, ["generic", "jsx", "structuralTyping"])).toEqual([
      "jsx",
      "structuralTyping",
    ]);
  });

  it("returns nothing when every expected category has at least one call site", () => {
    const tallies = tallyBy(rows("match", 1, { categories: ["generic"] }), (r) => r.categories);

    expect(findUncoveredCategories(tallies, ["generic"])).toEqual([]);
  });
});

describe("formatOracleTable", () => {
  it("renders one row per label under the given title with the mismatch rate as a percentage", () => {
    const tallies = tallyBy(
      [...rows("missed", 1, { categories: ["generic"] }), ...rows("match", 3, { categories: ["generic"] })],
      (r) => r.categories,
    );

    const table = formatOracleTable("By type feature", tallies);

    expect(table).toContain("By type feature");
    expect(table).toContain("generic");
    expect(table).toContain("25.0%");
  });

  it("renders a placeholder row when there is nothing to tally", () => {
    expect(formatOracleTable("By type feature", [])).toContain("(no call sites)");
  });
});

/** The checker's declaration, defaulted to an ordinary in-project method. */
function target(overrides: Partial<OracleTargetFacts> = {}): OracleTargetFacts {
  return {
    relPath: "src/core/runner.ts",
    symbolId: "Runner.run",
    shortName: "run",
    declarationKind: "MethodDeclaration",
    declarationOnly: false,
    anonymousCallable: false,
    origin: "project",
    ...overrides,
  };
}

describe("reconcileOracleWrongFile", () => {
  it("reads a checker answer naming an interface member as agreement when the chain named a same-named implementation", () => {
    const mismatch = row({
      verdict: "wrongFile",
      chain: { targetRelPath: "src/core/runner.ts", targetSymbolId: "Runner.run" },
      target: target({
        relPath: "src/core/contracts/runnable.ts",
        symbolId: "Runnable.run",
        declarationKind: "MethodSignature",
        declarationOnly: true,
      }),
    });

    expect(reconcileOracleWrongFile(mismatch)).toEqual("interfaceVsImpl");
  });

  it("counts a wrongFile as a defect when the two sides named different members", () => {
    const mismatch = row({
      verdict: "wrongFile",
      chain: { targetRelPath: "src/core/runner.ts", targetSymbolId: "Runner.stop" },
      target: target({
        relPath: "src/core/contracts/runnable.ts",
        symbolId: "Runnable.run",
        declarationKind: "MethodSignature",
        declarationOnly: true,
      }),
    });

    expect(reconcileOracleWrongFile(mismatch)).toEqual("defect");
  });

  it("reconciles by declaration-site path when the checker's target sits under contracts and the members agree", () => {
    const mismatch = row({
      verdict: "wrongFile",
      chain: { targetRelPath: "src/core/runner.ts", targetSymbolId: "Runner.run" },
      target: target({ relPath: "src/core/contracts/types/codegraph.ts", symbolId: "Runnable.run" }),
    });

    expect(reconcileOracleWrongFile(mismatch)).toEqual("declarationSitePath");
  });

  it("counts a wrongFile as a defect when the checker named a concrete declaration on an ordinary path", () => {
    const mismatch = row({
      verdict: "wrongFile",
      chain: { targetRelPath: "src/core/runner.ts", targetSymbolId: "Runner.run" },
      target: target({ relPath: "src/core/domains/explore/searcher.ts", symbolId: "Searcher.run" }),
    });

    expect(reconcileOracleWrongFile(mismatch)).toEqual("defect");
  });

  it("counts a wrongFile with no recorded checker declaration as a defect rather than excusing it", () => {
    expect(reconcileOracleWrongFile(row({ verdict: "wrongFile" }))).toEqual("defect");
  });
});

describe("reconcileOracleMissed", () => {
  it("calls a missed call site unmodellable when the checker's target is an anonymous callable", () => {
    const mismatch = row({
      verdict: "missed",
      target: target({
        symbolId: null,
        shortName: null,
        declarationKind: "ArrowFunction",
        anonymousCallable: true,
      }),
    });

    expect(reconcileOracleMissed(mismatch)).toEqual("anonymousCallable");
  });

  it("calls a missed call site unmodellable when the target has no symbol the graph could point an edge at", () => {
    const mismatch = row({ verdict: "missed", target: target({ symbolId: null }) });

    expect(reconcileOracleMissed(mismatch)).toEqual("unpinnedTarget");
  });

  it("counts a missed call site as a defect when the checker's target is a pinned project symbol", () => {
    expect(reconcileOracleMissed(row({ verdict: "missed", target: target() }))).toEqual("defect");
  });
});

describe("reconcileOraclePhantom", () => {
  it("calls a phantom on a default-lib member a builtin match even though the lib declares it on an interface", () => {
    const phantom = row({
      verdict: "phantom",
      chain: { targetRelPath: "src/core/infra/buffer.ts", targetSymbolId: "ChunkBuffer.push" },
      target: target({
        relPath: "node_modules/typescript/lib/lib.es5.d.ts",
        symbolId: null,
        shortName: "push",
        declarationKind: "MethodSignature",
        declarationOnly: true,
        origin: "defaultLib",
      }),
    });

    expect(reconcileOraclePhantom(phantom)).toEqual("builtinMember");
  });

  it("holds back a verdict when an external package declares the member on an interface the project may implement", () => {
    const phantom = row({
      verdict: "phantom",
      chain: { targetRelPath: "src/core/adapters/qdrant.ts", targetSymbolId: "QdrantStore.search" },
      target: target({
        relPath: "node_modules/@qdrant/js-client-rest/dist/types/api.d.ts",
        symbolId: null,
        shortName: "search",
        declarationKind: "MethodSignature",
        declarationOnly: true,
        origin: "externalPackage",
      }),
    });

    expect(reconcileOraclePhantom(phantom)).toEqual("externalInterfaceMatch");
  });

  it("counts a phantom on a concrete external declaration as a fabricated edge", () => {
    const phantom = row({
      verdict: "phantom",
      chain: { targetRelPath: "src/core/infra/log.ts", targetSymbolId: "Logger.write" },
      target: target({
        relPath: "node_modules/pino/lib/proto.d.ts",
        symbolId: null,
        shortName: "write",
        origin: "externalPackage",
      }),
    });

    expect(reconcileOraclePhantom(phantom)).toEqual("externalPackageMember");
  });

  it("counts a phantom whose external interface declares a different member as a fabricated edge", () => {
    const phantom = row({
      verdict: "phantom",
      chain: { targetRelPath: "src/core/infra/log.ts", targetSymbolId: "Logger.write" },
      target: target({
        relPath: "node_modules/pino/lib/proto.d.ts",
        symbolId: null,
        shortName: "flush",
        declarationOnly: true,
        origin: "externalPackage",
      }),
    });

    expect(reconcileOraclePhantom(phantom)).toEqual("externalPackageMember");
  });

  it("still counts a fabricated edge when the chain named project source for a call that leaves the project", () => {
    const phantom = row({
      verdict: "phantom",
      chain: { targetRelPath: "src/core/infra/buffer.ts", targetSymbolId: "ChunkBuffer.join" },
      target: target({
        relPath: "node_modules/typescript/lib/lib.es5.d.ts",
        symbolId: null,
        shortName: "join",
        declarationOnly: true,
        origin: "defaultLib",
      }),
    });

    expect(reconcileOraclePhantom(phantom)).toEqual("builtinMember");
  });

  it("sets aside a phantom whose target is the project's own compiled output as a measurement artifact", () => {
    const phantom = row({
      verdict: "phantom",
      chain: { targetRelPath: "src/core/runner.ts", targetSymbolId: "Runner.run" },
      target: target({ relPath: "build/core/runner.d.ts", symbolId: null, origin: "generatedInRepo" }),
    });

    expect(reconcileOraclePhantom(phantom)).toEqual("generatedInRepo");
  });
});

/** The first node of `kind` in a parsed snippet — the declaration under test. */
function declarationOfKind(code: string, kind: ts.SyntaxKind): ts.Declaration {
  const source = ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found === undefined && node.kind === kind) found = node;
    if (found === undefined) ts.forEachChild(node, visit);
  };
  visit(source);
  if (found === undefined) throw new Error(`no ${ts.SyntaxKind[kind]} in fixture`);
  return found as ts.Declaration;
}

describe("describeOracleDeclaration", () => {
  it("names a function-typed interface property by the property it hangs off", () => {
    const declaration = declarationOfKind(
      "interface SymbolTable { hydrate: (persisted: string) => void; }",
      ts.SyntaxKind.FunctionType,
    );

    expect(describeOracleDeclaration(declaration).shortName).toEqual("hydrate");
  });

  it("treats a function-typed interface property as a declaration site", () => {
    const declaration = declarationOfKind(
      "interface SymbolTable { hydrate: (persisted: string) => void; }",
      ts.SyntaxKind.FunctionType,
    );

    expect(describeOracleDeclaration(declaration).declarationOnly).toEqual(true);
  });

  it("treats an interface method signature as a declaration site", () => {
    const declaration = declarationOfKind("interface Runnable { run(): void; }", ts.SyntaxKind.MethodSignature);

    expect(describeOracleDeclaration(declaration)).toEqual({
      shortName: "run",
      declarationKind: "MethodSignature",
      declarationOnly: true,
      anonymousCallable: false,
    });
  });

  it("treats an abstract method as a declaration site", () => {
    const declaration = declarationOfKind(
      "abstract class Base { abstract run(): void; }",
      ts.SyntaxKind.MethodDeclaration,
    );

    expect(describeOracleDeclaration(declaration).declarationOnly).toEqual(true);
  });

  it("treats a concrete class method as neither a declaration site nor anonymous", () => {
    const declaration = declarationOfKind("class Runner { run(): void {} }", ts.SyntaxKind.MethodDeclaration);

    expect(describeOracleDeclaration(declaration)).toEqual({
      shortName: "run",
      declarationKind: "MethodDeclaration",
      declarationOnly: false,
      anonymousCallable: false,
    });
  });

  it("names an arrow function bound to a const rather than calling it unmodellable", () => {
    const declaration = declarationOfKind("const run = () => {};", ts.SyntaxKind.ArrowFunction);

    expect(describeOracleDeclaration(declaration)).toMatchObject({ shortName: "run", anonymousCallable: false });
  });

  it("calls an inline callback argument unmodellable", () => {
    const declaration = declarationOfKind("items.map(() => 1);", ts.SyntaxKind.ArrowFunction);

    expect(describeOracleDeclaration(declaration)).toMatchObject({ shortName: null, anonymousCallable: true });
  });

  it("calls a callback parameter unmodellable even though it carries a name", () => {
    const declaration = declarationOfKind("function each(cb: () => void) { cb(); }", ts.SyntaxKind.Parameter);

    expect(describeOracleDeclaration(declaration).anonymousCallable).toEqual(true);
  });
});

describe("decomposeOracleMismatches", () => {
  it("splits every mismatch kind into its reasons and reports the residual defect count", () => {
    const input = [
      row({
        verdict: "wrongFile",
        chain: { targetRelPath: "src/core/runner.ts", targetSymbolId: "Runner.run" },
        target: target({ relPath: "src/core/contracts/runnable.ts", declarationOnly: true }),
      }),
      row({
        verdict: "wrongFile",
        chain: { targetRelPath: "src/core/runner.ts", targetSymbolId: "Runner.run" },
        target: target({ relPath: "src/core/domains/explore/searcher.ts" }),
      }),
      row({ verdict: "missed", target: target({ symbolId: null, anonymousCallable: true }) }),
      row({ verdict: "missed", target: target() }),
      row({
        verdict: "phantom",
        chain: { targetRelPath: "src/core/infra/buffer.ts", targetSymbolId: "ChunkBuffer.push" },
        target: target({ relPath: "node_modules/typescript/lib/lib.es5.d.ts", origin: "defaultLib" }),
      }),
    ];

    const [decomposition] = decomposeOracleMismatches(input, () => ["all"]);

    expect(decomposition.wrongFile).toEqual({
      total: 2,
      interfaceVsImpl: 1,
      declarationSitePath: 0,
      inheritedConstructor: 0,
      defect: 1,
    });
    expect(decomposition.missed).toEqual({ total: 2, anonymousCallable: 1, unpinnedTarget: 0, defect: 1 });
    expect(decomposition.phantom).toEqual({
      total: 1,
      generatedInRepo: 0,
      builtinMember: 1,
      externalInterfaceMatch: 0,
      externalPackageMember: 0,
      defect: 1,
    });
  });

  it("counts a multi-label row once under each of its categories", () => {
    const input = [
      row({
        categories: ["generic", "structuralTyping"],
        verdict: "missed",
        target: target({ symbolId: null, anonymousCallable: true }),
      }),
    ];

    const decompositions = decomposeOracleMismatches(input, (r) => r.categories);

    expect(decompositions.map((d) => d.label).sort()).toEqual(["generic", "structuralTyping"]);
    expect(decompositions.every((d) => d.missed.anonymousCallable === 1)).toEqual(true);
  });

  it("reports nothing for a corpus the chain and the checker agree on", () => {
    const input = [...rows("match", 3), ...rows("fileOnly", 2), ...rows("agreeExternal", 4)];

    expect(decomposeOracleMismatches(input, () => ["all"])).toEqual([]);
  });

  it("counts only the mismatches of a category that also carries agreement", () => {
    const input = [
      ...rows("match", 7, { categories: ["generic"] }),
      ...rows("agreeExternal", 5, { categories: ["generic"] }),
      row({ categories: ["generic"], verdict: "missed", target: target() }),
    ];

    const [decomposition] = decomposeOracleMismatches(input, (r) => r.categories);

    expect(decomposition.label).toEqual("generic");
    expect(decomposition.missed).toEqual({ total: 1, anonymousCallable: 0, unpinnedTarget: 0, defect: 1 });
  });
});

describe("isOutsideProjectSource, through diffResolution (bd tea-rags-mcp-2mvc2)", () => {
  it("reads a chain answer naming a dependency's ESM typings as agreement rather than a fabricated edge", () => {
    const chain = { targetRelPath: "node_modules/zustand/esm/index.d.mts", targetSymbolId: "create" };

    expect(diffResolution(chain, { kind: "external" })).toEqual("agreeExternal");
  });

  it("reads a chain answer naming a dependency's CommonJS typings as agreement", () => {
    const chain = { targetRelPath: "node_modules/zod/v3/index.d.cts", targetSymbolId: "ZodType.parse" };

    expect(diffResolution(chain, { kind: "external" })).toEqual("agreeExternal");
  });

  it("reads a chain answer under a nested workspace's node_modules as agreement", () => {
    const chain = { targetRelPath: "packages/web/node_modules/msw/lib/core/http.d.ts", targetSymbolId: "http.get" };

    expect(diffResolution(chain, { kind: "external" })).toEqual("agreeExternal");
  });

  it("still calls an in-project chain answer a phantom when the path merely reads like a dependency", () => {
    const chain = { targetRelPath: "src/core/node_modules_helper.ts", targetSymbolId: "resolvePackage" };

    expect(diffResolution(chain, { kind: "external" })).toEqual("phantom");
  });
});

/** One walker-emitted call ref, defaulted so each test states only its own shape. */
function callRef(overrides: Partial<CallRef> = {}): CallRef {
  return { callText: "run()", receiver: null, member: "run", startLine: 1, ...overrides };
}

describe("classifyUnlocatedCallShape", () => {
  it("names a JSX component tag, whose element is not a call expression at all", () => {
    const call = callRef({ callText: "<Card title={t} />", member: "Card", jsx: true });

    expect(classifyUnlocatedCallShape(call)).toEqual("jsxTag");
  });

  it("names a dotted JSX tag by its shape rather than by the receiver it carries", () => {
    const call = callRef({ callText: "<UI.Panel />", receiver: "UI", member: "Panel", jsx: true });

    expect(classifyUnlocatedCallShape(call)).toEqual("jsxTag");
  });

  it("names a super call by its receiver, ahead of the constructor member the walker re-shapes it to", () => {
    const call = callRef({ callText: "super(message)", receiver: "super", member: "constructor" });

    expect(classifyUnlocatedCallShape(call)).toEqual("superCall");
  });

  it("names an instantiation whose receiver is a real class", () => {
    const call = callRef({ callText: "new Repo(db)", receiver: "Repo", member: "constructor" });

    expect(classifyUnlocatedCallShape(call)).toEqual("constructorCall");
  });

  it("names a computed callee the walker already tagged dynamic", () => {
    const call = callRef({ callText: "handlers[kind](x)", member: "handlers[kind]", dynamicSend: true });

    expect(classifyUnlocatedCallShape(call)).toEqual("dynamicSend");
  });

  it("names a dynamic import, whose target is a module and not a signature", () => {
    const call = callRef({ callText: 'import("./config.js")', member: "import" });

    expect(classifyUnlocatedCallShape(call)).toEqual("dynamicImport");
  });

  it("names a method handed over as a value, which has no call-like node at its coordinate", () => {
    const call = callRef({ callText: "this.tick", receiver: "this", member: "tick" });

    expect(classifyUnlocatedCallShape(call)).toEqual("methodReference");
  });

  it("leaves a real call the finders could not place in the residual bucket", () => {
    const call = callRef({ callText: "handler.run.bind(handler)", receiver: "handler", member: "run" });

    expect(classifyUnlocatedCallShape(call)).toEqual("coordinateMiss");
  });
});

describe("referencesCallableValue", () => {
  it("claims a method handed over as a value — there is no call node, but there is a symbol", () => {
    const call = callRef({ callText: "this.tick", receiver: "this", member: "tick" });

    expect(referencesCallableValue(call)).toEqual(true);
  });

  it("claims a `.bind` site, whose walker member names the RECEIVER of the invoker", () => {
    const call = callRef({ callText: "handler.run.bind(handler)", receiver: "handler", member: "run" });

    expect(referencesCallableValue(call)).toEqual(true);
  });

  it("claims a `.call` site for the same reason", () => {
    const call = callRef({
      callText: "toolbar.handlers.video.call(toolbar)",
      receiver: "toolbar.handlers",
      member: "video",
    });

    expect(referencesCallableValue(call)).toEqual(true);
  });

  it("declines the invoker the walker could NOT unwrap — a computed callee names no value", () => {
    const call = callRef({
      callText: "registry[k].call(x)",
      receiver: "registry[k]",
      member: "call",
      dynamicSend: true,
    });

    expect(referencesCallableValue(call)).toEqual(false);
  });

  it("declines an ordinary call the finders missed, so the residual bucket keeps its diagnostic value", () => {
    const call = callRef({ callText: "handleSubmit(onSubmit)()", member: "handleSubmit" });

    expect(referencesCallableValue(call)).toEqual(false);
  });

  it("declines a JSX tag, which the tag-name finder already locates", () => {
    const call = callRef({ callText: "<Card />", member: "Card", jsx: true });

    expect(referencesCallableValue(call)).toEqual(false);
  });

  it("declines a dynamic import, whose target is a module rather than a value", () => {
    const call = callRef({ callText: 'import("./config.js")', member: "import" });

    expect(referencesCallableValue(call)).toEqual(false);
  });
});

describe("findValueReference", () => {
  /** A parsed fixture, positions preserved so line lookup is real. */
  function sourceOf(code: string): ts.SourceFile {
    return ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true);
  }

  it("finds the property a method reference names, at the argument's own coordinate", () => {
    const source = sourceOf(["class Ticker {", "  start() {", "    items.map(this.tick);", "  }", "}"].join("\n"));

    const found = findValueReference(source, 3, "tick");

    expect(found?.text).toEqual("tick");
    expect(found?.parent.kind).toEqual(ts.SyntaxKind.PropertyAccessExpression);
  });

  it("finds the bare identifier a `.bind` site invokes, which is the invoker's receiver", () => {
    const source = sourceOf(["function wire(f) {", "  return f.bind(null);", "}"].join("\n"));

    expect(findValueReference(source, 2, "f")?.text).toEqual("f");
  });

  it("reports nothing when the line carries no identifier of that name", () => {
    const source = sourceOf(["const a = 1;", "const b = 2;"].join("\n"));

    expect(findValueReference(source, 2, "tick")).toEqual(null);
  });

  it("keeps the two coordinates apart, so a same-named reference on another line is not returned", () => {
    const source = sourceOf(["run(this.tick);", "run(other.tick);"].join("\n"));

    const first = findValueReference(source, 1, "tick");
    const second = findValueReference(source, 2, "tick");

    expect(first).not.toEqual(second);
    expect(first?.parent.getText(source)).toEqual("this.tick");
    expect(second?.parent.getText(source)).toEqual("other.tick");
  });
});

describe("tallyUnlocatedShapes", () => {
  it("counts every shape the oracle failed to locate a node for", () => {
    const input = [
      row({ unlocatedShape: "jsxTag" }),
      row({ unlocatedShape: "jsxTag" }),
      row({ unlocatedShape: "coordinateMiss" }),
    ];

    const tally = tallyUnlocatedShapes(input);

    expect(tally.jsxTag).toEqual(2);
    expect(tally.coordinateMiss).toEqual(1);
    expect(tally.superCall).toEqual(0);
  });

  it("reports a zero for every shape when every call site was located", () => {
    expect(Object.values(tallyUnlocatedShapes(rows("match", 5)))).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("isScoredSource", () => {
  it("scores the TypeScript extensions this harness's chain actually resolves", () => {
    expect(isScoredSource("app/javascript/Card.tsx")).toEqual(true);
    expect(isScoredSource("src/core/runner.ts")).toEqual(true);
  });

  it("keeps JavaScript out of the scored corpus, since a different resolver owns it", () => {
    expect(isScoredSource("app/javascript/legacy/util.js")).toEqual(false);
    expect(isScoredSource("app/javascript/legacy/Card.jsx")).toEqual(false);
    expect(isScoredSource("scripts/build.mjs")).toEqual(false);
  });
});

describe("reconcileOracleWrongFile on a super call (bd tea-rags-mcp-2mvc2)", () => {
  it("reads the checker naming the constructor that RUNS and the chain naming the immediate parent as agreement", () => {
    const mismatch = row({
      receiverKind: "super",
      callText: "super(message)",
      verdict: "wrongFile",
      chain: { targetRelPath: "src/core/adapters/errors.ts", targetSymbolId: "InfraError#constructor" },
      target: target({
        relPath: "src/core/infra/errors.ts",
        symbolId: "TeaRagsError#constructor",
        shortName: "constructor",
        declarationKind: "Constructor",
      }),
    });

    expect(reconcileOracleWrongFile(mismatch)).toEqual("inheritedConstructor");
  });

  it("still counts an instantiation pointed at the wrong class as a defect", () => {
    const mismatch = row({
      receiverKind: "constant",
      callText: "new Repo(db)",
      verdict: "wrongFile",
      chain: { targetRelPath: "src/core/other-repo.ts", targetSymbolId: "OtherRepo#constructor" },
      target: target({
        relPath: "src/core/repo.ts",
        symbolId: "Repo#constructor",
        shortName: "constructor",
        declarationKind: "Constructor",
      }),
    });

    expect(reconcileOracleWrongFile(mismatch)).toEqual("defect");
  });

  it("counts a super site as a defect when the checker's target is not a constructor at all", () => {
    const mismatch = row({
      receiverKind: "super",
      callText: "super.run()",
      verdict: "wrongFile",
      chain: { targetRelPath: "src/core/base.ts", targetSymbolId: "Base#run" },
      target: target({
        relPath: "src/core/domains/explore/searcher.ts",
        symbolId: "Searcher#start",
        shortName: "start",
      }),
    });

    expect(reconcileOracleWrongFile(mismatch)).toEqual("defect");
  });
});

/**
 * The corpus has to be the one production builds nodes for
 * (bd tea-rags-mcp-2mvc2). Scoring a gitignored or generated file is scoring
 * code the resolver never sees — on taxdome that inflated `wrongFile` ~8x.
 */
describe("collectSourceFiles corpus scope", () => {
  let repoRoot: string;

  function write(relPath: string, content: string): void {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "oracle-corpus-"));
    write(".gitignore", "app/generated/\n");
    write("app/runner.ts", "export function run() {}\n");
    write("app/legacy.js", "export function legacy() {}\n");
    write("app/runner.test.ts", "it('runs', () => {});\n");
    write("app/generated/api-client.ts", "export function fetchAll() {}\n");
    write("app/types.d.ts", "export declare function typed(): void;\n");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("keeps the source files production builds codegraph nodes for", async () => {
    const exclude = await buildCorpusExclusionFilter(repoRoot, new LanguageFactory());

    const selection = await collectSourceFiles(repoRoot, join(repoRoot, "app"), exclude);

    expect(selection.kept).toEqual(["app/legacy.js", "app/runner.ts"]);
  });

  it("counts a gitignored file apart from one the codegraph layer drops", async () => {
    const exclude = await buildCorpusExclusionFilter(repoRoot, new LanguageFactory());

    const selection = await collectSourceFiles(repoRoot, join(repoRoot, "app"), exclude);

    expect(selection.ingestIgnored).toEqual(1);
    expect(selection.codegraphExcluded).toEqual(1);
  });

  it("scores the whole tree when no filter is supplied, the shape every caller before this used", async () => {
    const selection = await collectSourceFiles(repoRoot, join(repoRoot, "app"));

    expect(selection.kept).toEqual([
      "app/generated/api-client.ts",
      "app/legacy.js",
      "app/runner.test.ts",
      "app/runner.ts",
    ]);
    expect(selection.ingestIgnored).toEqual(0);
  });
});
