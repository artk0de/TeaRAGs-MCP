/**
 * Swift nested-function filter — keeps a `func` declared inside another
 * function's body out of the chunkable set.
 *
 * Registering a hook chain flips `canRecurseAsContainer` to true for EVERY
 * Swift child (`childIsRubyHookContainer` is a bare "does this language have
 * hooks" check), which would make the engine recurse into a method that
 * contains a nested `func` and emit only the inner one — the exact shadowing
 * bd tea-rags-mcp-07fr documents. Rejecting nested functions at discovery keeps
 * the outer method a leaf chunk.
 *
 * It also fixes a standing tier-1 bug: a TOP-LEVEL Swift func with a nested
 * func ≥50 chars already loses its own chunk today, because
 * `alwaysExtractChildren` sends it down the child-extraction path regardless of
 * hooks. Before this filter, `find_symbol("outerCalculation")` came up empty
 * and only `outerCalculation#innerAccumulate` existed.
 */

import { describe, expect, it } from "vitest";

import {
  isNestedInsideFunctionBody,
  swiftNestedFunctionFilterHook,
} from "../../../../../../src/core/domains/language/swift/chunking/nested-function-filter.js";
import { chunkFor, chunkSwift, findFirst, parseSwift } from "./__helpers__/swift-chunking.js";

const TOP_LEVEL_WITH_NESTED = `func outerCalculation(values: [Int]) -> Int {
    func innerAccumulate(running: Int, next: Int) -> Int {
        let scaled = next * 2
        return running + scaled
    }
    return values.reduce(0, innerAccumulate)
}`;

const METHOD_WITH_NESTED = `struct Calculator {
    func outerCalculation(values: [Int]) -> Int {
        func innerAccumulate(running: Int, next: Int) -> Int {
            let scaled = next * 2
            return running + scaled
        }
        return values.reduce(0, innerAccumulate)
    }
}`;

describe("isNestedInsideFunctionBody", () => {
  it("is false for a top-level function", async () => {
    const root = await parseSwift(TOP_LEVEL_WITH_NESTED);
    expect(isNestedInsideFunctionBody(findFirst(root, "function_declaration"))).toBe(false);
  });

  it("is false for a method declared in a type body", async () => {
    const root = await parseSwift(METHOD_WITH_NESTED);
    expect(isNestedInsideFunctionBody(findFirst(root, "function_declaration"))).toBe(false);
  });

  it("is true for a function declared inside another function's body", async () => {
    const root = await parseSwift(TOP_LEVEL_WITH_NESTED);
    const outer = findFirst(root, "function_declaration");
    const inner = findFirst(findFirst(outer, "function_body"), "function_declaration");
    expect(inner.text.startsWith("func innerAccumulate")).toBe(true);
    expect(isNestedInsideFunctionBody(inner)).toBe(true);
  });

  it("is true for an init declared inside a function body", async () => {
    const root = await parseSwift(`func makeLedger() -> Ledger {
    struct Local {
        init(period: BillingPeriod) {
            self.period = period
            self.entries = []
        }
    }
    return Ledger(period: .january)
}`);
    const inner = findFirst(root, "init_declaration");
    expect(isNestedInsideFunctionBody(inner)).toBe(true);
  });
});

describe("swiftNestedFunctionFilterHook", () => {
  it("has no opinion on nodes that are not function or init declarations", async () => {
    const root = await parseSwift(METHOD_WITH_NESTED);
    const container = findFirst(root, "class_declaration");
    expect(
      swiftNestedFunctionFilterHook.filterNode?.(container, METHOD_WITH_NESTED, "Calculator.swift"),
    ).toBeUndefined();
  });

  it("rejects a nested function and accepts an outer one", async () => {
    const root = await parseSwift(TOP_LEVEL_WITH_NESTED);
    const outer = findFirst(root, "function_declaration");
    const inner = findFirst(findFirst(outer, "function_body"), "function_declaration");

    expect(swiftNestedFunctionFilterHook.filterNode?.(outer, TOP_LEVEL_WITH_NESTED, "Calc.swift")).toBe(true);
    expect(swiftNestedFunctionFilterHook.filterNode?.(inner, TOP_LEVEL_WITH_NESTED, "Calc.swift")).toBe(false);
  });
});

describe("nested functions end to end", () => {
  it("keeps a top-level function addressable instead of emitting only its inner func", async () => {
    const chunks = await chunkSwift(TOP_LEVEL_WITH_NESTED, "Sources/Billing/Calc.swift");

    expect(chunkFor(chunks, "outerCalculation")).toBeDefined();
    expect(chunkFor(chunks, "outerCalculation")?.content).toContain("func innerAccumulate");
    expect(chunkFor(chunks, "outerCalculation#innerAccumulate")).toBeUndefined();
  });

  it("keeps a method with a nested func a single leaf chunk", async () => {
    const chunks = await chunkSwift(METHOD_WITH_NESTED, "Sources/Billing/Calculator.swift");

    expect(chunkFor(chunks, "Calculator#outerCalculation")).toBeDefined();
    expect(chunkFor(chunks, "Calculator#outerCalculation#innerAccumulate")).toBeUndefined();
  });
});
