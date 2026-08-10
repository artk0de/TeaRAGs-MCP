import { describe, expect, it } from "vitest";

import { renderReadme } from "../../../../../src/core/domains/language/capability/readme.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

describe("renderReadme", () => {
  const out = renderReadme(new LanguageFactory().capabilities());

  it("emits the section heading wrapped in a details spoiler", () => {
    expect(out).toContain("## Languages Compatibilities");
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>");
    expect(out).toContain("</details>");
  });

  it("brackets the inline HTML with an MD033 disable/enable pair", () => {
    expect(out).toContain("markdownlint-disable MD033");
    expect(out).toContain("markdownlint-enable MD033");
  });

  it("adds a moon summary hook and a self-documenting legend", () => {
    expect(out).toContain("<summary>🌗 Supported languages & support levels</summary>");
    expect(out).toContain(
      "**Support:** 🌕 maximum · 🌔 full · 🌖 high · 🌓 medium · 🌗 moderate · 🌒 partial/low · 🌘 minimal · 🌑 none",
    );
  });

  it("maps each tier to a distinct moon phase (full≠high, medium≠moderate)", () => {
    expect(out).toContain("🌔 **full**");
    expect(out).toContain("🌖 **high**");
    expect(out).toContain("🌓 **medium**");
    expect(out).toContain("🌗 **moderate**");
    // the historically-confusable pairs must NOT collapse onto one phase
    expect(out).not.toContain("🌔 **high**");
    expect(out).not.toContain("🌗 **medium**");
  });

  it("renders language names in bold-italic", () => {
    expect(out).toContain("| ***TypeScript*** |");
    expect(out).toContain("| ***Ruby*** |");
  });

  it("orders rows by capability score (TS/JS/Ruby band first, Markdown above char-langs)", () => {
    const at = (needle: string): number => {
      const i = out.indexOf(needle);
      expect(i, `expected ${needle} in output`).toBeGreaterThan(-1);
      return i;
    };
    const ts = at("***TypeScript***");
    const js = at("***JavaScript***");
    const ruby = at("***Ruby***");
    const python = at("***Python***");
    const bash = at("***Bash***");
    const md = at("***Markdown***");
    const sql = at("***sql***");
    // 323 band (TS · JS · Ruby) before the 222 band (Python …)
    expect(ts).toBeLessThan(js);
    expect(js).toBeLessThan(ruby);
    expect(ruby).toBeLessThan(python);
    // Markdown (20) lands above the fallback char-langs (0) but below Bash (121)
    expect(bash).toBeLessThan(md);
    expect(md).toBeLessThan(sql);
  });

  it("renders hook short phrases (not raw hook names) in the AST cell", () => {
    expect(out).toContain("method-body splitting"); // bodyChunker short
    expect(out).toContain("spec scope splitting"); // rspecScopeChunker short
    expect(out).toContain("module/class split"); // JsChunkClassifier short
    expect(out).not.toContain("bodyChunker");
    expect(out).not.toContain("rspecScopeChunker");
    expect(out).not.toContain("jsAssignmentFilter");
    expect(out).not.toContain("GoChunkClassifier");
  });

  it("includes the human-facing resolution tech", () => {
    expect(out).toContain("14-strategy chain (10 tree-sitter + 4 ts.Program/typeChecker");
  });

  it("renders Ruby typing tiers with per-tier moon badges", () => {
    expect(out).toContain("untyped 🌖 **high**");
    expect(out).toContain("YARD 🌕 **maximum**");
    expect(out).toContain("RBS/Sorbet 🌑 **TBD**");
  });

  it("renders Markdown as full-tier AST with ToC + smart chunking", () => {
    const mdRow = out.split("\n").find((l) => l.includes("***Markdown***"));
    expect(mdRow).toBeDefined();
    expect(mdRow!).toContain("🌔 **full**");
    expect(mdRow!).toContain("ToC + smart chunking");
  });

  it("lists the unsupported fallback languages", () => {
    expect(out).toContain("sql");
    expect(out).toContain("CharacterChunker");
  });
});
