/**
 * Ruby walker abstract-stub capture (bd tea-rags-mcp-bcdfe). Spec:
 * docs/superpowers/specs/2026-07-06-ruby-self-receiver-dispatch-design.md
 * ("Generalized predicate" clause 3 + the "Abstract-stub detection" risk).
 *
 * `ChunkExtraction.isAbstractStub` marks a method def whose body carries NO
 * implementation, so the self-dispatch discovery can treat it as abstract-in-A
 * (the REDIRECT terminal) instead of a concrete definer. Detection is
 * deliberately CONSERVATIVE — over-marking turns a real base method into a hook
 * and fabricates edges — so exactly three body shapes qualify:
 *
 *   - empty body (`def m; end`, with or without params)
 *   - a single-statement `raise NotImplementedError` (bare / `::`-rooted / with
 *     a message / `.new(…)`)
 *   - a single-statement `super` (bare, parens, or with args)
 *
 * Everything else — a guard clause before the raise, two statements, a real
 * expression, a different error class — is a REAL body and MUST stay unmarked
 * (the flag is absent, never `false`, so the payload stays lean).
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

/**
 * Extract a single-method fixture: the source is always `class A` + one method
 * starting on line 2. Returns that method chunk's `isAbstractStub`.
 */
function stubFlagOf(src: string, symbolId = "A#m", endLine = 20): boolean | undefined {
  const tree = parse(src);
  const ex = extractFromRubyFile({
    tree,
    code: src,
    relPath: "a.rb",
    language: "ruby",
    chunks: [{ symbolId, startLine: 2, endLine, scope: ["A"] }],
  });
  return ex.chunks.find((c) => c.symbolId === symbolId)?.isAbstractStub;
}

describe("ruby walker isAbstractStub — qualifying stub bodies (bcdfe)", () => {
  it("marks an empty body (`def m; end`)", () => {
    expect(stubFlagOf("class A\n  def m; end\nend\n")).toBe(true);
  });

  it("marks an empty body WITH parameters (`def m(a, b)\\nend`)", () => {
    expect(stubFlagOf("class A\n  def m(a, b)\n  end\nend\n")).toBe(true);
  });

  it("marks a comment-only body (no executable statement)", () => {
    expect(stubFlagOf("class A\n  def m\n    # subclasses implement this\n  end\nend\n")).toBe(true);
  });

  it("marks a bare `raise NotImplementedError`", () => {
    expect(stubFlagOf("class A\n  def m\n    raise NotImplementedError\n  end\nend\n")).toBe(true);
  });

  it("marks `raise ::NotImplementedError` (root-scoped constant)", () => {
    expect(stubFlagOf("class A\n  def m\n    raise ::NotImplementedError\n  end\nend\n")).toBe(true);
  });

  it('marks `raise NotImplementedError, "msg"` (message argument)', () => {
    expect(stubFlagOf('class A\n  def m\n    raise NotImplementedError, "implement me"\n  end\nend\n')).toBe(true);
  });

  it("marks `raise NotImplementedError.new(...)` (constructed error)", () => {
    expect(stubFlagOf('class A\n  def m\n    raise NotImplementedError.new("nope")\n  end\nend\n')).toBe(true);
  });

  it("marks a single bare `super`", () => {
    expect(stubFlagOf("class A\n  def m\n    super\n  end\nend\n")).toBe(true);
  });

  it("marks a single `super()` / `super(args)` delegation", () => {
    expect(stubFlagOf("class A\n  def m\n    super()\n  end\nend\n")).toBe(true);
    expect(stubFlagOf("class A\n  def m(a)\n    super(a)\n  end\nend\n")).toBe(true);
  });

  it("marks a CLASS-method stub (`def self.m; end`)", () => {
    expect(stubFlagOf("class A\n  def self.m; end\nend\n", "A.m")).toBe(true);
  });

  it("marks a stub declared through the inline `private def` form", () => {
    expect(stubFlagOf("class A\n  private def m\n    raise NotImplementedError\n  end\nend\n")).toBe(true);
  });
});

describe("ruby walker isAbstractStub — real bodies stay UNMARKED (conservatism)", () => {
  it("does NOT mark a guard clause followed by the raise (two statements)", () => {
    expect(
      stubFlagOf("class A\n  def m\n    return if skip?\n    raise NotImplementedError\n  end\nend\n"),
    ).toBeUndefined();
  });

  it("does NOT mark a comment followed by real code", () => {
    expect(stubFlagOf("class A\n  def m\n    # note\n    do_the_work\n  end\nend\n")).toBeUndefined();
  });

  it("does NOT mark a two-statement body", () => {
    expect(stubFlagOf("class A\n  def m\n    prepare\n    finish\n  end\nend\n")).toBeUndefined();
  });

  it("does NOT mark `raise ArgumentError` (a different error class is real behaviour)", () => {
    expect(stubFlagOf('class A\n  def m\n    raise ArgumentError, "bad"\n  end\nend\n')).toBeUndefined();
  });

  it("does NOT mark a namespaced look-alike (`Legacy::NotImplementedError`)", () => {
    expect(stubFlagOf("class A\n  def m\n    raise Legacy::NotImplementedError\n  end\nend\n")).toBeUndefined();
  });

  it("does NOT mark a bare `raise` re-raise (no error class argument)", () => {
    expect(stubFlagOf("class A\n  def m\n    raise\n  end\nend\n")).toBeUndefined();
  });

  it("does NOT mark a single real expression body", () => {
    expect(stubFlagOf("class A\n  def m\n    compute + 1\n  end\nend\n")).toBeUndefined();
  });

  it("does NOT mark a conditional `super` (`super if enabled?`)", () => {
    expect(stubFlagOf("class A\n  def m\n    super if enabled?\n  end\nend\n")).toBeUndefined();
  });

  it("does NOT mark an endless method with a real value (`def m = nil`)", () => {
    expect(stubFlagOf("class A\n  def m = nil\nend\n")).toBeUndefined();
  });

  it("leaves non-method chunks (class bodies) unmarked", () => {
    const src = "class A\n  def m; end\nend\n";
    const tree = parse(src);
    const ex = extractFromRubyFile({
      tree,
      code: src,
      relPath: "a.rb",
      language: "ruby",
      chunks: [{ symbolId: "A", startLine: 1, endLine: 3, scope: [] }],
    });
    expect(ex.chunks.find((c) => c.symbolId === "A")?.isAbstractStub).toBeUndefined();
  });
});
