import { describe, expect, it } from "vitest";

import { renderRule } from "../../../../../src/core/domains/language/capability/rule.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

describe("renderRule", () => {
  const out = renderRule(new LanguageFactory().capabilities());

  it("emits the H1 and the matrix header", () => {
    expect(out).toContain("# Language Compatibility");
    expect(out).toContain("| Language | AST code chunking | Tests code chunking | Codegraph capability |");
  });

  it("renders a flat codegraph tier in bold", () => {
    expect(out).toContain("| **Go** | **full** · tree-sitter | **medium** · generic AST | **moderate** |");
  });

  it("renders Ruby typing-tiered codegraph inline", () => {
    expect(out).toContain("untyped **high** · YARD **maximum** · RBS/Sorbet **TBD**");
  });

  it("appends the unsupported fallback row", () => {
    expect(out).toContain("| **sql / jsonc / json** | **none** · CharacterChunker | **none** | **none** |");
  });

  it("renders markdown N/A tests tier from detection label", () => {
    expect(out).toContain("**N/A** · doc-only");
  });

  it("does NOT bake measured resolveSuccessRate numbers into the static rule", () => {
    expect(out).not.toContain("0.83");
    expect(out).not.toContain("0.25");
  });

  it("keeps the realized-trust prose that points the agent at prime", () => {
    expect(out).toContain("resolveSuccessRate");
    expect(out).toContain("prime");
  });

  it("marks the file as generated", () => {
    expect(out).toContain("GENERATED");
  });
});
