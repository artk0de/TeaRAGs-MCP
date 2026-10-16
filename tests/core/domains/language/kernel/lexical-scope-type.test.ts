/**
 * A short type name resolved from the caller's lexical scope (bd
 * tea-rags-mcp-2m83f.32.1): innermost scope first, then outward, then the top
 * level; a tie at the first declaring level is silence.
 */
import { describe, expect, it } from "vitest";

import {
  nearestScopedTypeName,
  type LexicalScopeTypePorts,
} from "../../../../../src/core/domains/language/kernel/lexical-scope-type.js";

interface FakeCtx {
  readonly chain: readonly string[];
  readonly declared: Readonly<Record<string, readonly string[]>>;
}

const ports: LexicalScopeTypePorts<FakeCtx> = {
  scopeChain: (ctx) => ctx.chain,
  typesDeclaredIn: (name, scope, ctx) => ctx.declared[`${scope}|${name}`] ?? [],
};

const CHAIN = ["A::B::C", "A::B", "A", ""];

describe("nearestScopedTypeName", () => {
  it("the innermost declaring scope wins over outer and top-level namesakes", () => {
    const ctx = { chain: CHAIN, declared: { "A::B|Item": ["A::B::Item"], "A|Item": ["A::Item"], "|Item": ["Item"] } };
    expect(nearestScopedTypeName("Item", ctx, ports)).toBe("A::B::Item");
  });

  it("falls back to an outer scope when the inner ones declare nothing", () => {
    const ctx = { chain: CHAIN, declared: { "A|Item": ["A::Item"], "|Item": ["Item"] } };
    expect(nearestScopedTypeName("Item", ctx, ports)).toBe("A::Item");
  });

  it("falls back to the top level last", () => {
    expect(nearestScopedTypeName("Item", { chain: CHAIN, declared: { "|Item": ["Item"] } }, ports)).toBe("Item");
  });

  it("a tie at the first declaring level is silent, never the next scope out", () => {
    const ctx = { chain: CHAIN, declared: { "A::B|Item": ["A::B::Item", "A::B::Other::Item"], "A|Item": ["A::Item"] } };
    expect(nearestScopedTypeName("Item", ctx, ports)).toBeUndefined();
  });

  it("is silent when no scope declares the name", () => {
    expect(nearestScopedTypeName("Item", { chain: CHAIN, declared: { "X|Item": ["X::Item"] } }, ports)).toBeUndefined();
  });
});
