/**
 * Python's typed-receiver passes run on the K4 kernel skeletons (bd
 * tea-rags-mcp-m99j1.1.5): each is a thin subclass binding Python's typing port
 * and member lookup, and keeps the `name` chain-tally `--defer` and the oracle
 * `answeredBy` columns key on. Behaviour is pinned by each strategy's own test
 * file; this one pins the composition.
 */
import { describe, expect, it } from "vitest";

import {
  ChainTypeSymbolResolutionStrategy,
  ConventionReceiverSymbolResolutionStrategy,
  LocalBindingSymbolResolutionStrategy,
} from "../../../../../../../src/core/domains/language/kernel/receiver-typed-strategies.js";
import { PythonChainTypeSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-chain-type.js";
import { PythonLocalBindingSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-local-binding.js";
import { PythonNamingConventionSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-naming-convention.js";

const cfg = { mode: "strict" as const };

describe("Python receiver-typed strategies on the kernel", () => {
  it("chainType is the kernel's ChainTypeSymbolResolutionStrategy", () => {
    const strategy = new PythonChainTypeSymbolResolutionStrategy(cfg);
    expect(strategy).toBeInstanceOf(ChainTypeSymbolResolutionStrategy);
    expect(strategy.name).toBe("chainType");
  });

  it("localBinding is the kernel's LocalBindingSymbolResolutionStrategy", () => {
    const strategy = new PythonLocalBindingSymbolResolutionStrategy(cfg);
    expect(strategy).toBeInstanceOf(LocalBindingSymbolResolutionStrategy);
    expect(strategy.name).toBe("localBinding");
  });

  it("namingConvention is the kernel's ConventionReceiverSymbolResolutionStrategy", () => {
    const strategy = new PythonNamingConventionSymbolResolutionStrategy(cfg);
    expect(strategy).toBeInstanceOf(ConventionReceiverSymbolResolutionStrategy);
    expect(strategy.name).toBe("namingConvention");
  });
});
