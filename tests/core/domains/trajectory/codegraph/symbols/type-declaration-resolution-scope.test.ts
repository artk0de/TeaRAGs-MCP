/**
 * Which languages' `typeDeclarations` reach RESOLUTION (bd tea-rags-mcp-vi0wx,
 * spec §1b). Every walker may publish the facts for the naming lexicon, but only
 * a language whose resolver reads them — the capability fact
 * `codegraph.resolverReadsTypeDeclarations` — may enter the run-global map and
 * the persisted pass-1 slice. Another language's facts must widen neither: the
 * Swift resolver reads the map run-globally, and a slice row per declaring file
 * of every language would rewrite most of `cg_pass1_aggregates` for nothing.
 */

import { describe, expect, it } from "vitest";

import type {
  FileExtraction,
  GlobalSymbolTable,
  TypeDeclarationFact,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { collectTypeDeclarationReaders } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-readers.js";

const DECLARATIONS: readonly TypeDeclarationFact[] = [
  { typeId: "Account", symbolKind: "class", line: 3, reopens: false, conforms: ["Base"] },
];

function extraction(relPath: string, language: string): FileExtraction {
  return { relPath, language, imports: [], fileScope: [], chunks: [], typeDeclarations: DECLARATIONS };
}

/** A factory whose every language has a resolver answering nothing — enough to reach the slice build. */
function resolvingFactory(languages: string[]): LanguageFactoryDescriptor {
  return {
    supported: () => languages,
    create: () => ({ resolver: { resolve: () => null } }),
  } as unknown as LanguageFactoryDescriptor;
}

const EMPTY_TABLE = { lookup: () => [], lookupByShortName: () => [] } as unknown as GlobalSymbolTable;

describe("collectTypeDeclarationReaders", () => {
  it("names exactly the languages whose capability says their resolver reads type declarations", () => {
    expect([...collectTypeDeclarationReaders(new LanguageFactory())]).toEqual(["swift"]);
  });

  it("names none without a factory, or with one that publishes no capabilities", () => {
    expect(collectTypeDeclarationReaders(undefined).size).toBe(0);
    expect(collectTypeDeclarationReaders(resolvingFactory(["swift"])).size).toBe(0);
  });
});

describe("CodegraphRunState bound to the type-declaration readers", () => {
  it("keeps a reading language's declarations in the run-global map", () => {
    const runState = new CodegraphRunState([], new Map(), new Map(), new Set(["swift"]));
    runState.absorb(extraction("Sources/Account.swift", "swift"), []);
    expect(runState.typeDeclarations).toEqual({ "Sources/Account.swift": DECLARATIONS });
  });

  it("leaves another language's declarations out of the run-global map", () => {
    const runState = new CodegraphRunState([], new Map(), new Map(), new Set(["swift"]));
    runState.absorb(extraction("app/models/account.rb", "ruby"), []);
    expect(runState.typeDeclarations).toEqual({});
  });
});

describe("CallEdgeResolutionRunner persists type declarations only for a reading language", () => {
  function sliceOf(language: string, relPath: string) {
    const runState = new CodegraphRunState([], new Map(), new Map(), new Set(["swift"]));
    const runner = new CallEdgeResolutionRunner(resolvingFactory([language]), runState);
    return runner.resolve(extraction(relPath, language), EMPTY_TABLE).pass1Aggregates;
  }

  it("carries a reading language's declarations in the pass-1 slice", () => {
    expect(sliceOf("swift", "Sources/Account.swift")?.typeDeclarations).toEqual(DECLARATIONS);
  });

  it("writes no slice for another language whose only run-global fact is its declarations", () => {
    expect(sliceOf("ruby", "app/models/account.rb")).toBeUndefined();
  });
});
