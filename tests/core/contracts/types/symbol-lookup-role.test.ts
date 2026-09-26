/**
 * Which declaration kinds a call can land on (bd tea-rags-mcp-jqvbn).
 *
 * A call names two things: the CALLEE (the member being invoked) and, for a
 * member call, the RECEIVER it is invoked on. A type-only declaration
 * (`interface`, `type` alias) is neither at runtime. An `enum` or a module-level
 * constant is no callee, but `Color.values()` / `CONFIG.get()` hold one as the
 * receiver. A definition whose kind the walker never recorded keeps answering
 * both, which is the behaviour of every row written before migration 035.
 */
import { describe, expect, it } from "vitest";

import {
  isCallReceiverSymbolKind,
  isCallTargetSymbolKind,
  symbolKindServesLookupRole,
  type SymbolDefinitionKind,
} from "../../../../src/core/contracts/types/codegraph-symbols.js";

const CALLABLE: readonly SymbolDefinitionKind[] = ["class", "module", "function", "method"];

describe("isCallTargetSymbolKind", () => {
  it.each(CALLABLE)("accepts %s", (kind) => {
    expect(isCallTargetSymbolKind(kind)).toBe(true);
  });

  it.each(["interface", "type_alias", "enum", "constant"] as const)("rejects %s", (kind) => {
    expect(isCallTargetSymbolKind(kind)).toBe(false);
  });

  it("accepts a definition with no recorded kind", () => {
    expect(isCallTargetSymbolKind(undefined)).toBe(true);
  });
});

describe("isCallReceiverSymbolKind", () => {
  it.each([...CALLABLE, "enum", "constant"] as const)("accepts %s", (kind) => {
    expect(isCallReceiverSymbolKind(kind)).toBe(true);
  });

  it.each(["interface", "type_alias"] as const)("rejects %s", (kind) => {
    expect(isCallReceiverSymbolKind(kind)).toBe(false);
  });

  it("accepts a definition with no recorded kind", () => {
    expect(isCallReceiverSymbolKind(undefined)).toBe(true);
  });
});

describe("symbolKindServesLookupRole", () => {
  it("routes the callee role to the call-target predicate", () => {
    expect(symbolKindServesLookupRole("enum", "callee")).toBe(false);
    expect(symbolKindServesLookupRole("function", "callee")).toBe(true);
  });

  it("routes the receiver role to the receiver predicate", () => {
    expect(symbolKindServesLookupRole("enum", "receiver")).toBe(true);
    expect(symbolKindServesLookupRole("type_alias", "receiver")).toBe(false);
  });

  it("serves every kind when no role is asked for", () => {
    expect(symbolKindServesLookupRole("interface", undefined)).toBe(true);
    expect(symbolKindServesLookupRole(undefined, undefined)).toBe(true);
  });
});
