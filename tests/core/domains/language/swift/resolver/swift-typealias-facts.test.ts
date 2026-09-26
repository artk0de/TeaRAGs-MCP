/**
 * A `type_alias` fact on the `typeDeclarations` channel is a NAMING fact (bd
 * tea-rags-mcp-vi0wx, spec §1b): the walker publishes every non-local Swift
 * `typealias` for the naming lexicon, and the resolver's read of the channel
 * skips it. A project `typealias JSONDecoder = …` does not make `JSONDecoder` a
 * type the project declares, so every resolver question answers exactly as it
 * did before aliases were published.
 */

import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  SymbolDefinition,
  TypeDeclarationFact,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { SwiftCallResolver } from "../../../../../../src/core/domains/language/swift/resolver/swift-resolver.js";
import {
  swiftConformances,
  swiftDeclarationKinds,
  swiftDeclaringFiles,
  swiftSelfConstraintsAt,
} from "../../../../../../src/core/domains/language/swift/resolver/swift-type-declarations.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function table(
  rows: Record<string, ({ symbolId: string; scope: string[] } & Partial<SymbolDefinition>)[]>,
): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(rows)) {
    t.upsertFile(
      relPath,
      defs.map((d) => ({
        ...d,
        fqName: d.symbolId,
        shortName: (d.symbolId.split(/[#.]/).pop() ?? d.symbolId).replace(/~\d+$/, ""),
        relPath,
      })),
    );
  }
  return t;
}

function ctx(over: Partial<CallContext> & Pick<CallContext, "callerFile" | "symbolTable">): CallContext {
  return { callerScope: [], imports: [], ...over };
}

function call(receiver: string | null, member: string, startLine = 10): CallRef {
  return { callText: `${receiver ?? ""}.${member}()`, receiver, member, startLine };
}

function alias(typeId: string, line = 1): TypeDeclarationFact {
  return { typeId, symbolKind: "type_alias", line, reopens: false };
}

describe("Swift resolver — a typealias fact is not a declared type", () => {
  const extendedOnly = table({
    "Sources/JSONDecoder+Alamofire.swift": [{ symbolId: "JSONDecoder", scope: [] }],
    "Sources/Request.swift": [{ symbolId: "Request#decode", scope: ["Request"] }],
  });
  const extension: TypeDeclarationFact = {
    typeId: "JSONDecoder",
    symbolKind: "class",
    line: 1,
    reopens: true,
    conforms: ["DataDecoder"],
  };

  function constructionContext(typeDeclarations: CallContext["typeDeclarations"]): CallContext {
    return ctx({
      callerFile: "Sources/Request.swift",
      callerScope: ["Request"],
      symbolTable: extendedOnly,
      typeDeclarations,
    });
  }

  it("keeps a construction of a type the project only extends off the graph beside an alias namesake", () => {
    const resolver = new SwiftCallResolver();
    const site = call(null, "JSONDecoder");
    const before = constructionContext({ "Sources/JSONDecoder+Alamofire.swift": [extension] });
    const after = constructionContext({
      "Sources/JSONDecoder+Alamofire.swift": [extension],
      "Sources/Aliases.swift": [alias("JSONDecoder")],
    });
    expect(resolver.resolve(site, before)).toBeNull();
    expect(resolver.resolve(site, after)).toBeNull();
    expect(resolver.hasInProjectDefinition(site, after)).toBe(resolver.hasInProjectDefinition(site, before));
    expect(resolver.hasInProjectDefinition(site, after)).toBe(false);
  });

  it("lands a construction on the declaring file when an alias names the type elsewhere", () => {
    const reopened = table({
      "Sources/World.swift": [{ symbolId: "World", scope: [] }],
      "Sources/World+DSL.swift": [{ symbolId: "World", scope: [] }],
      "Sources/Spec.swift": [{ symbolId: "Spec#run", scope: ["Spec"] }],
    });
    const target = new SwiftCallResolver().resolve(
      call(null, "World"),
      ctx({
        callerFile: "Sources/Spec.swift",
        callerScope: ["Spec"],
        symbolTable: reopened,
        typeDeclarations: {
          "Sources/World.swift": [{ typeId: "World", symbolKind: "class", line: 1, reopens: false }],
          "Sources/World+DSL.swift": [{ typeId: "World", symbolKind: "class", line: 1, reopens: true }],
          "Sources/Handler.swift": [alias("Handler"), alias("World.Handler", 3)],
        },
      }),
    );
    expect(target).toEqual({ targetRelPath: "Sources/World.swift", targetSymbolId: "World" });
  });

  it("answers every declared-type question as if the alias were absent", () => {
    const context = ctx({
      callerFile: "Sources/Aliases.swift",
      symbolTable: table({}),
      typeDeclarations: {
        "Sources/Aliases.swift": [alias("Handler"), alias("Request.Validation", 4)],
        "Sources/Request.swift": [
          { typeId: "Request", symbolKind: "class", line: 1, reopens: false, declarationKind: "class" },
        ],
      },
    });
    expect(swiftDeclaringFiles("Handler", context)).toBeUndefined();
    expect(swiftDeclaringFiles("Request.Validation", context)).toBeUndefined();
    expect(swiftDeclarationKinds("Handler", context)).toBeUndefined();
    expect(swiftConformances("Handler", context)).toEqual([]);
    expect(swiftSelfConstraintsAt("Handler", 1, context)).toEqual([]);
    // The real declaration next to it still answers.
    expect(swiftDeclaringFiles("Request", context)).toEqual(new Set(["Sources/Request.swift"]));
    expect(swiftDeclarationKinds("Request", context)).toEqual(new Set(["class"]));
  });
});
