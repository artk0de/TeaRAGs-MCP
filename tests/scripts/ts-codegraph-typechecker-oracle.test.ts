import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  decomposeOracleMismatches,
  describeOracleDeclaration,
  diffResolution,
  findUncoveredCategories,
  flagTrackBPriorities,
  formatOracleTable,
  reconcileOracleMissed,
  reconcileOraclePhantom,
  reconcileOracleWrongFile,
  tallyBy,
  type OracleOutcome,
  type OracleRow,
  type OracleTargetFacts,
  type OracleVerdict,
} from "../../scripts/ts-codegraph-typechecker-oracle.js";

/** One call-site row, defaulted so each test states only the axis it exercises. */
function row(overrides: Partial<OracleRow> = {}): OracleRow {
  return {
    relPath: "src/a.ts",
    startLine: 1,
    callText: "run()",
    receiverKind: "bareCall",
    categories: ["plain"],
    verdict: "match",
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
