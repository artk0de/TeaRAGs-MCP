/**
 * Tests for ruby walker arity/visibility/argCount capture (bd xlnub Task 2).
 *
 * extractFromRubyFile populates:
 *   - ChunkExtraction.arity   (AritySignature)  per method def
 *   - ChunkExtraction.visibility                 per method def
 *   - CallRef.argCount                           per call site
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

/** Build a full extractFromRubyFile input with pre-specified chunk definitions. */
function exWith(src: string, chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[]) {
  const tree = parse(src);
  return extractFromRubyFile({ tree, code: src, relPath: "a.rb", language: "ruby", chunks });
}

/** Find a ChunkExtraction by its symbolId. */
function chunkById(ex: ReturnType<typeof extractFromRubyFile>, id: string) {
  return ex.chunks.find((c) => c.symbolId === id);
}

describe("ruby walker arity/visibility/argCount capture (xlnub)", () => {
  it("required + optional + splat arity", () => {
    // A#m(a, b = 1, *rest): minRequired=1, maxPositional=2, hasSplat=true
    const src = `class A\n  def m(a, b = 1, *rest)\n  end\nend\n`;
    // Line 1: class A
    // Line 2: def m(a, b = 1, *rest)
    // Line 3: end
    // Line 4: end
    const ex = exWith(src, [{ symbolId: "A#m", startLine: 2, endLine: 3, scope: ["A"] }]);
    const chunk = chunkById(ex, "A#m");
    expect(chunk).toBeDefined();
    expect(chunk?.arity).toEqual({ minRequired: 1, maxPositional: 2, hasSplat: true });
  });

  it("no-parameter method yields zero arity", () => {
    const src = `class A\n  def noop; end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#noop", startLine: 2, endLine: 2, scope: ["A"] }]);
    const chunk = chunkById(ex, "A#noop");
    expect(chunk).toBeDefined();
    expect(chunk?.arity).toEqual({ minRequired: 0, maxPositional: 0, hasSplat: false });
  });

  it("private mode switch marks subsequent defs private; public default before", () => {
    // Line 1: class A
    // Line 2: def pub; end
    // Line 3: private
    // Line 4: def priv; end
    // Line 5: end
    const src = `class A\n  def pub; end\n  private\n  def priv; end\nend\n`;
    const ex = exWith(src, [
      { symbolId: "A#pub", startLine: 2, endLine: 2, scope: ["A"] },
      { symbolId: "A#priv", startLine: 4, endLine: 4, scope: ["A"] },
    ]);
    expect(chunkById(ex, "A#pub")?.visibility).toBe("public");
    expect(chunkById(ex, "A#priv")?.visibility).toBe("private");
  });

  it("inline private def form marks only that method private", () => {
    // Line 1: class A
    // Line 2: private def secret; end
    // Line 3: end
    const src = `class A\n  private def secret; end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#secret", startLine: 2, endLine: 2, scope: ["A"] }]);
    expect(chunkById(ex, "A#secret")?.visibility).toBe("private");
  });

  it("call-site positional argCount excludes block and kwargs", () => {
    // A#go calls x.perform(1, 2, key: 3) { } — positional count = 2
    // Line 1: class A
    // Line 2: def go(x)
    // Line 3:   x.perform(1, 2, key: 3) { }
    // Line 4: end
    // Line 5: end
    const src = `class A\n  def go(x)\n    x.perform(1, 2, key: 3) { }\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#go", startLine: 2, endLine: 4, scope: ["A"] }]);
    const goChunk = chunkById(ex, "A#go");
    expect(goChunk).toBeDefined();
    const performCall = goChunk?.calls.find((c) => c.member === "perform");
    expect(performCall).toBeDefined();
    expect(performCall?.argCount).toBe(2);
  });

  it("call with no arguments yields argCount 0", () => {
    const src = `class A\n  def go\n    x.run\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#go", startLine: 2, endLine: 4, scope: ["A"] }]);
    const goChunk = chunkById(ex, "A#go");
    const runCall = goChunk?.calls.find((c) => c.member === "run");
    expect(runCall).toBeDefined();
    expect(runCall?.argCount).toBe(0);
  });

  it("private :foo AFTER def foo (backward form) marks method private", () => {
    // Dominant Ruby idiom: def first, private :name at the bottom.
    // Without two-pass, the method is emitted as "public" before symVis is populated.
    // Line 1: class A
    // Line 2: def secret; end
    // Line 3: private :secret
    // Line 4: end
    const src = `class A\n  def secret; end\n  private :secret\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#secret", startLine: 2, endLine: 2, scope: ["A"] }]);
    expect(chunkById(ex, "A#secret")?.visibility).toBe("private");
  });

  it("private :foo BEFORE def foo (forward form) marks method private", () => {
    // Less common but valid: declare visibility before the def.
    // Line 1: class A
    // Line 2: private :secret
    // Line 3: def secret; end
    // Line 4: end
    const src = `class A\n  private :secret\n  def secret; end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#secret", startLine: 3, endLine: 3, scope: ["A"] }]);
    expect(chunkById(ex, "A#secret")?.visibility).toBe("private");
  });
});
