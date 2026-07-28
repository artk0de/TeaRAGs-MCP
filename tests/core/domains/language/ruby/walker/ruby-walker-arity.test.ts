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

describe("ruby walker kwarg capture (d9o7o)", () => {
  it("captures required (no default) + optional (defaulted) kwarg names and hasSplat", () => {
    // def m(a, b:, c: 1, **opts): required [b], optional [c] (c: has a default), hasSplat true
    const src = `class A\n  def m(a, b:, c: 1, **opts)\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#m", startLine: 2, endLine: 3, scope: ["A"] }]);
    expect(chunkById(ex, "A#m")?.kwargs).toEqual({ required: ["b"], optional: ["c"], hasSplat: true });
  });

  it("captures a method with ONLY optional kwargs (full declared set for extra-unknown check)", () => {
    const src = `class A\n  def m(c: 1)\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#m", startLine: 2, endLine: 3, scope: ["A"] }]);
    expect(chunkById(ex, "A#m")?.kwargs).toEqual({ required: [], optional: ["c"], hasSplat: false });
  });

  it("no kwargs → kwargs undefined", () => {
    const src = `class A\n  def m(a, b = 1)\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#m", startLine: 2, endLine: 3, scope: ["A"] }]);
    expect(chunkById(ex, "A#m")?.kwargs).toBeUndefined();
  });

  it("captures call-site kwarg keys and detects ** double-splat", () => {
    // x.m(1, b: 2, **h): kwargKeys = [b], hasKwargSplat = true
    const src = `class A\n  def go(x, h)\n    x.m(1, b: 2, **h)\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#go", startLine: 2, endLine: 4, scope: ["A"] }]);
    const mCall = chunkById(ex, "A#go")?.calls.find((c) => c.member === "m");
    expect(mCall?.kwargKeys).toEqual(["b"]);
    expect(mCall?.hasKwargSplat).toBe(true);
  });

  it("call with only positional args → kwargKeys undefined, hasKwargSplat undefined", () => {
    const src = `class A\n  def go(x)\n    x.m(1, 2)\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#go", startLine: 2, endLine: 4, scope: ["A"] }]);
    const mCall = chunkById(ex, "A#go")?.calls.find((c) => c.member === "m");
    expect(mCall?.kwargKeys).toBeUndefined();
    expect(mCall?.hasKwargSplat).toBeUndefined();
  });
});

describe("ruby walker block capture (d9o7o)", () => {
  it("def with yield → acceptsBlock true", () => {
    const src = `class A\n  def m\n    yield 1\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#m", startLine: 2, endLine: 4, scope: ["A"] }]);
    expect(chunkById(ex, "A#m")?.acceptsBlock).toBe(true);
  });

  it("def with &block param → acceptsBlock true", () => {
    const src = `class A\n  def m(&blk)\n    blk.call\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#m", startLine: 2, endLine: 4, scope: ["A"] }]);
    expect(chunkById(ex, "A#m")?.acceptsBlock).toBe(true);
  });

  it("def with neither yield nor &block → acceptsBlock false (proven non-yielder)", () => {
    const src = `class A\n  def m(a)\n    a + 1\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#m", startLine: 2, endLine: 4, scope: ["A"] }]);
    expect(chunkById(ex, "A#m")?.acceptsBlock).toBe(false);
  });

  it("call with a brace block → passesBlock true", () => {
    const src = `class A\n  def go(x)\n    x.each { |i| i }\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#go", startLine: 2, endLine: 4, scope: ["A"] }]);
    expect(chunkById(ex, "A#go")?.calls.find((c) => c.member === "each")?.passesBlock).toBe(true);
  });

  it("call with a do..end block → passesBlock true", () => {
    const src = `class A\n  def go(x)\n    x.each do |i|\n      i\n    end\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#go", startLine: 2, endLine: 6, scope: ["A"] }]);
    expect(chunkById(ex, "A#go")?.calls.find((c) => c.member === "each")?.passesBlock).toBe(true);
  });

  it("call with no block → passesBlock undefined", () => {
    const src = `class A\n  def go(x)\n    x.run\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#go", startLine: 2, endLine: 4, scope: ["A"] }]);
    expect(chunkById(ex, "A#go")?.calls.find((c) => c.member === "run")?.passesBlock).toBeUndefined();
  });
});

/**
 * bd tea-rags-mcp-jn5j0 — the collector used to walk to the first `class` /
 * `module` and iterate that body's DIRECT statements, so a def under
 * `class << self`, inside a class-body block, or at file scope carried NO
 * signature at all. The CODEGRAPH_DEFPARAM_ORACLE census put 2 157 taxdome defs
 * with positional params in that blind spot — 17.6 % of the corpus — starving
 * the whole narrowing cascade (`ArityNarrower` / `KwargNarrower` /
 * `VisibilityNarrower` / `BlockNarrower`), `isAbstractStub` hydration and the
 * bvalc param-type fold.
 *
 * `collectSymbols` already emits these defs as CLASS-level chunks (`A.build`),
 * so the fix is traversal-only: the signature keys were always addressable.
 */
describe("ruby walker signature capture outside a plain class body (jn5j0)", () => {
  it("captures arity for a def inside class << self", () => {
    // Line 1: class A
    // Line 2:   class << self
    // Line 3:     def build(a, b = 1, *rest)
    // Line 4:     end
    // Line 5:   end
    // Line 6: end
    const src = `class A\n  class << self\n    def build(a, b = 1, *rest)\n    end\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A.build", startLine: 3, endLine: 4, scope: ["A"] }]);
    expect(chunkById(ex, "A.build")?.arity).toEqual({ minRequired: 1, maxPositional: 2, hasSplat: true });
  });

  it("captures kwargs and positional param names for a def inside class << self", () => {
    const src = `class A\n  class << self\n    def build(a, b:, c: 1)\n    end\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A.build", startLine: 3, endLine: 4, scope: ["A"] }]);
    const chunk = chunkById(ex, "A.build");
    expect(chunk?.kwargs).toEqual({ required: ["b"], optional: ["c"], hasSplat: false });
    expect(chunk?.paramNames).toEqual(["a"]);
  });

  it("tracks the visibility state machine INSIDE class << self, with its own public default", () => {
    // The singleton body is a separate visibility scope: `private` inside it
    // must not leak out, and the enclosing class's state must not leak in.
    // Line 1: class A
    // Line 2:   private
    // Line 3:   class << self
    // Line 4:     def pub; end
    // Line 5:     private
    // Line 6:     def hidden; end
    // Line 7:   end
    // Line 8: end
    const src = `class A\n  private\n  class << self\n    def pub; end\n    private\n    def hidden; end\n  end\nend\n`;
    const ex = exWith(src, [
      { symbolId: "A.pub", startLine: 4, endLine: 4, scope: ["A"] },
      { symbolId: "A.hidden", startLine: 6, endLine: 6, scope: ["A"] },
    ]);
    expect(chunkById(ex, "A.pub")?.visibility).toBe("public");
    expect(chunkById(ex, "A.hidden")?.visibility).toBe("private");
  });

  it("honours the symbol form of a visibility declaration inside class << self", () => {
    const src = `class A\n  class << self\n    def secret; end\n    private :secret\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A.secret", startLine: 3, endLine: 3, scope: ["A"] }]);
    expect(chunkById(ex, "A.secret")?.visibility).toBe("private");
  });

  it("captures acceptsBlock and isAbstractStub for defs inside class << self", () => {
    const src = `class A\n  class << self\n    def each_thing\n      yield 1\n    end\n    def todo\n      raise NotImplementedError\n    end\n  end\nend\n`;
    const ex = exWith(src, [
      { symbolId: "A.each_thing", startLine: 3, endLine: 5, scope: ["A"] },
      { symbolId: "A.todo", startLine: 6, endLine: 8, scope: ["A"] },
    ]);
    expect(chunkById(ex, "A.each_thing")?.acceptsBlock).toBe(true);
    expect(chunkById(ex, "A.todo")?.isAbstractStub).toBe(true);
  });

  it("captures a def nested in a class-body block (`included do … end`)", () => {
    // Line 1: module M
    // Line 2:   included do
    // Line 3:     def hooked(q)
    // Line 4:     end
    // Line 5:   end
    // Line 6: end
    const src = `module M\n  included do\n    def hooked(q)\n    end\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "M#hooked", startLine: 3, endLine: 4, scope: ["M"] }]);
    const chunk = chunkById(ex, "M#hooked");
    expect(chunk?.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
    expect(chunk?.visibility).toBe("public");
  });

  it("captures a def nested in a block on a RECEIVER-ful class-body call (`class_eval do … end`)", () => {
    // A receiver on the block's call node used to short-circuit the statement
    // loop before the block was ever entered.
    const src = `class A\n  Helper.class_eval do\n    def patched(a, b)\n    end\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#patched", startLine: 3, endLine: 4, scope: ["A"] }]);
    expect(chunkById(ex, "A#patched")?.arity).toEqual({ minRequired: 2, maxPositional: 2, hasSplat: false });
  });

  it("captures a top-level def (no enclosing class or module)", () => {
    const src = `def top_level(w)\nend\n`;
    const ex = exWith(src, [{ symbolId: "top_level", startLine: 1, endLine: 2, scope: [] }]);
    const chunk = chunkById(ex, "top_level");
    expect(chunk?.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
    expect(chunk?.visibility).toBe("public");
  });

  it("still reaches a class nested inside a conditional (no traversal regression)", () => {
    const src = `if RUBY_VERSION > "3"\n  class A\n    def m(a)\n    end\n  end\nend\n`;
    const ex = exWith(src, [{ symbolId: "A#m", startLine: 3, endLine: 4, scope: ["A"] }]);
    expect(chunkById(ex, "A#m")?.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
  });
});

/**
 * bd tea-rags-mcp-jn5j0 — `argCount` is the call-side half of `ArityNarrower`,
 * which DROPS a candidate whose positional arity cannot accept it. Counting a
 * non-positional argument therefore drops a CORRECT target: graphql-ruby's
 * `context.schema.after_any_lazies(loaded_values, &:itself)` counted 2 against
 * `def after_any_lazies(maybe_lazies)` and lost the only in-project definer.
 *
 * Three argument-list children are not positional slots, and a splat makes the
 * count unknowable:
 *   - `block_argument` (`&blk`, `&:sym`)      → a block, like `{ … }` / `do … end`
 *   - `hash_splat_argument` (`**opts`)         → keyword args, like `pair`
 *   - `splat_argument` (`*args`)               → 0..n slots, count NOT knowable
 * The splat case yields `undefined` rather than a number: the narrower's
 * contract is "missing evidence ⇒ keep", and a wrong number is not missing
 * evidence, it is false evidence.
 */
describe("ruby walker call-site argCount excludes non-positional arguments (jn5j0)", () => {
  const argCountOf = (src: string, member: string) => {
    const ex = exWith(src, [{ symbolId: "A#go", startLine: 2, endLine: 4, scope: ["A"] }]);
    return chunkById(ex, "A#go")?.calls.find((c) => c.member === member)?.argCount;
  };

  it("a block-pass argument (&:sym) is not a positional argument", () => {
    expect(argCountOf(`class A\n  def go(x)\n    x.run(v, &:itself)\n  end\nend\n`, "run")).toBe(1);
  });

  it("a block-pass argument (&blk) is not a positional argument", () => {
    expect(argCountOf(`class A\n  def go(x, blk)\n    x.run(v, &blk)\n  end\nend\n`, "run")).toBe(1);
  });

  it("a double-splat argument (**opts) is not a positional argument", () => {
    expect(argCountOf(`class A\n  def go(x)\n    x.run(a, b, **opts)\n  end\nend\n`, "run")).toBe(2);
  });

  it("a splat argument (*args) makes the positional count unknowable", () => {
    expect(argCountOf(`class A\n  def go(x)\n    x.run(*args)\n  end\nend\n`, "run")).toBeUndefined();
  });

  it("a splat among plain arguments still makes the count unknowable", () => {
    expect(argCountOf(`class A\n  def go(x)\n    x.run(a, *rest, b)\n  end\nend\n`, "run")).toBeUndefined();
  });

  it("plain positional arguments still count exactly", () => {
    expect(argCountOf(`class A\n  def go(x)\n    x.run(a, b, c)\n  end\nend\n`, "run")).toBe(3);
  });
});
