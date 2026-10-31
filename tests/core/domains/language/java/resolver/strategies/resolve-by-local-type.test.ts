import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { resolveByLocalType } from "../../../../../../../src/core/domains/language/java/resolver/strategies/shared.js";

type Hit = { relPath: string; symbolId: string };

function ctxWith(table: Record<string, Hit[]>): CallContext {
  return { symbolTable: { lookup: (key: string) => table[key] ?? [] } } as unknown as CallContext;
}

describe("Java resolveByLocalType", () => {
  it("prefers the instance form `Type#member` over the static form", () => {
    const ctx = ctxWith({
      "Repo#save": [{ relPath: "Repo.java", symbolId: "Repo#save" }],
      "Repo.save": [{ relPath: "Other.java", symbolId: "Repo.save" }],
    });
    expect(resolveByLocalType("Repo", "save", ctx, "strict")).toEqual({
      targetRelPath: "Repo.java",
      targetSymbolId: "Repo#save",
    });
  });

  it("falls back to the static form `Type.member` when no instance method matches", () => {
    const ctx = ctxWith({ "Util.of": [{ relPath: "Util.java", symbolId: "Util.of" }] });
    expect(resolveByLocalType("Util", "of", ctx, "strict")).toEqual({
      targetRelPath: "Util.java",
      targetSymbolId: "Util.of",
    });
  });

  it("routes an external type to a type-qualified target instead of a same-class guess", () => {
    expect(resolveByLocalType("List", "add", ctxWith({}), "strict")).toEqual({
      targetRelPath: "List",
      targetSymbolId: "List#add",
    });
  });

  it("treats an ambiguous instance match as unresolved in strict mode but takes the first in first mode", () => {
    const ambiguous = {
      "Repo#save": [
        { relPath: "a/Repo.java", symbolId: "Repo#save" },
        { relPath: "b/Repo.java", symbolId: "Repo#save" },
      ],
    };
    expect(resolveByLocalType("Repo", "save", ctxWith(ambiguous), "strict")).toEqual({
      targetRelPath: "Repo",
      targetSymbolId: "Repo#save",
    });
    expect(resolveByLocalType("Repo", "save", ctxWith(ambiguous), "first")).toEqual({
      targetRelPath: "a/Repo.java",
      targetSymbolId: "Repo#save",
    });
  });
});
