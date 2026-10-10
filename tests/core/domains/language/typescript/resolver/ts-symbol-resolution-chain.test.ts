import { describe, expect, it } from "vitest";

import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/program/index.js";
import type { ResolverConfig } from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { createTSSymbolResolutionChain } from "../../../../../../src/core/domains/language/typescript/resolver/ts-symbol-resolution-chain.js";

const REPO_ROOT = "/nonexistent-chain-order-root";

function makeCfg(): ResolverConfig {
  return { tsOptions: { baseUrl: REPO_ROOT, paths: {} }, mode: "strict" } as unknown as ResolverConfig;
}

describe("createTSSymbolResolutionChain", () => {
  it("orders the full chain with the type-checker tier present", () => {
    const programCache = new TSProgramCache({ repoRoot: REPO_ROOT, tsOptions: { baseUrl: REPO_ROOT, paths: {} } });

    const { strategies } = createTSSymbolResolutionChain(makeCfg(), programCache);

    expect(strategies.map((s) => s.name)).toEqual([
      "super",
      "thisMember",
      "fieldType",
      "localBinding",
      "namedImport",
      "typeCheckerJsxComponent",
      "importedCallee",
      "importBasename",
      "receiverSymbol",
      "lexicalCallee",
      "sameFile",
      "globalShortName",
      "importNarrowedFallback",
      "callResultCallee",
      "typeCheckerReturnType",
      "typeCheckerFallback",
      "structuralTyping",
    ]);
  });

  it("drops every checker-backed pass when the Program cache is absent", () => {
    const { strategies } = createTSSymbolResolutionChain(makeCfg(), null);

    expect(strategies.map((s) => s.name)).toEqual([
      "super",
      "thisMember",
      "fieldType",
      "localBinding",
      "namedImport",
      "importedCallee",
      "importBasename",
      "receiverSymbol",
      "sameFile",
      "globalShortName",
      "importNarrowedFallback",
    ]);
  });

  it("exposes the declared-type passes of the chain as the function-invoker subset, same instances", () => {
    const { strategies, functionInvokerSiteStrategies } = createTSSymbolResolutionChain(makeCfg(), null);

    expect(functionInvokerSiteStrategies.map((s) => s.name)).toEqual(["fieldType", "localBinding"]);
    expect(strategies[2]).toBe(functionInvokerSiteStrategies[0]);
    expect(strategies[3]).toBe(functionInvokerSiteStrategies[1]);
  });
});
