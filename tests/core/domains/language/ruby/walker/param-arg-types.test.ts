/**
 * bd tea-rags-mcp-bvalc — walker half of constructor-arg param typing.
 *
 * Invariants pinned here:
 *   - `ChunkExtraction.paramNames` records the LEADING run of plain required
 *     positionals only (past an optional/splat, index↔name is not a bijection);
 *   - `FileExtraction.knownTargetCallArgs` carries per-POSITION argument types
 *     for call sites whose callee is known from syntax alone (`Const.new`,
 *     constant-receiver factory verbs), with the Ruby constant-lookup candidate
 *     chain as the target;
 *   - `FileExtraction.classFieldParamLinks` records `@ivar = <param>` verbatim
 *     copies — the unresolved half of the ivar's type.
 *
 * All three are SILENT rather than approximate: an untypeable argument is a
 * `null` slot, a call site with no typeable argument emits nothing, and an
 * `@ivar` with two distinct parameter origins is dropped.
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

function exWith(src: string, chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[]) {
  const tree = parse(src);
  return extractFromRubyFile({ tree, code: src, relPath: "a.rb", language: "ruby", chunks });
}

describe("ruby walker — positional param names (bvalc)", () => {
  it("records the leading run of required positionals", () => {
    const src = ["class A", "  def initialize(firm, user)", "    @firm = firm", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "A#initialize", startLine: 2, endLine: 4, scope: ["A"] }]);
    expect(ex.chunks.find((c) => c.symbolId === "A#initialize")?.paramNames).toEqual(["firm", "user"]);
  });

  it("truncates at the first optional parameter — index no longer pins a name", () => {
    const src = ["class A", "  def initialize(a, b = 1, c)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "A#initialize", startLine: 2, endLine: 3, scope: ["A"] }]);
    expect(ex.chunks.find((c) => c.symbolId === "A#initialize")?.paramNames).toEqual(["a"]);
  });

  it("truncates at a splat but keeps the positionals before it", () => {
    const src = ["class A", "  def initialize(a, b, *rest)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "A#initialize", startLine: 2, endLine: 3, scope: ["A"] }]);
    expect(ex.chunks.find((c) => c.symbolId === "A#initialize")?.paramNames).toEqual(["a", "b"]);
  });

  it("a keyword-only signature records nothing", () => {
    const src = ["class A", "  def initialize(firm:, user:)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "A#initialize", startLine: 2, endLine: 3, scope: ["A"] }]);
    expect(ex.chunks.find((c) => c.symbolId === "A#initialize")?.paramNames).toBeUndefined();
  });
});

describe("ruby walker — known-target call args (bvalc)", () => {
  it("types a `Const.new(Const.new(...))` argument as an instance of the inner constant", () => {
    const src = ["class Caller", "  def go", "    Service.new(Firm.new)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 4, scope: ["Caller"] }]);
    expect(ex.knownTargetCallArgs).toEqual([
      { targets: ["Caller::Service#initialize", "Service#initialize"], argTypes: [{ form: "instance", name: "Firm" }] },
    ]);
  });

  it("types a typed LOCAL argument from the chunk's own bindings", () => {
    const src = ["class Caller", "  def go", "    firm = Firm.new", "    Service.new(firm)", "  end", "end", ""].join(
      "\n",
    );
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 5, scope: ["Caller"] }]);
    const forService = ex.knownTargetCallArgs?.find((r) => r.targets.includes("Service#initialize"));
    expect(forService?.argTypes).toEqual([{ form: "instance", name: "Firm" }]);
  });

  it("a bare CONSTANT argument is the class itself, not an instance", () => {
    const src = ["class Caller", "  def go", "    Service.new(Firm)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 4, scope: ["Caller"] }]);
    const forService = ex.knownTargetCallArgs?.find((r) => r.targets.includes("Service#initialize"));
    expect(forService?.argTypes).toEqual([{ form: "class", name: "Firm" }]);
  });

  it("types an `@ivar` argument through the class's own field types", () => {
    const src = [
      "class Caller",
      "  def setup",
      "    @firm = Firm.new",
      "  end",
      "  def go",
      "    Service.new(@firm)",
      "  end",
      "end",
      "",
    ].join("\n");
    const ex = exWith(src, [
      { symbolId: "Caller#setup", startLine: 2, endLine: 4, scope: ["Caller"] },
      { symbolId: "Caller#go", startLine: 5, endLine: 7, scope: ["Caller"] },
    ]);
    const forService = ex.knownTargetCallArgs?.find((r) => r.targets.includes("Service#initialize"));
    expect(forService?.argTypes).toEqual([{ form: "instance", name: "Firm" }]);
  });

  it("an untypeable argument is a null slot, not a guess", () => {
    const src = ["class Caller", "  def go", "    Service.new(1, Firm.new)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 4, scope: ["Caller"] }]);
    const forService = ex.knownTargetCallArgs?.find((r) => r.targets.includes("Service#initialize"));
    expect(forService?.argTypes).toEqual([null, { form: "instance", name: "Firm" }]);
  });

  it("a call site with NO typeable argument emits no record at all", () => {
    const src = ["class Caller", "  def go", "    Service.new(1, :sym)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 4, scope: ["Caller"] }]);
    expect(ex.knownTargetCallArgs?.some((r) => r.targets.includes("Service#initialize")) ?? false).toBe(false);
  });

  it("truncates the position list at a splat argument", () => {
    const src = ["class Caller", "  def go", "    Service.new(Firm.new, *rest, Other.new)", "  end", "end", ""].join(
      "\n",
    );
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 4, scope: ["Caller"] }]);
    const forService = ex.knownTargetCallArgs?.find((r) => r.targets.includes("Service#initialize"));
    expect(forService?.argTypes).toEqual([{ form: "instance", name: "Firm" }]);
  });

  it("truncates at a keyword pair — an implicit hash swallows every later position", () => {
    const src = ["class Caller", "  def go", "    Service.new(Firm.new, mode: 1)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 4, scope: ["Caller"] }]);
    const forService = ex.knownTargetCallArgs?.find((r) => r.targets.includes("Service#initialize"));
    expect(forService?.argTypes).toEqual([{ form: "instance", name: "Firm" }]);
  });

  it("walks lexical scopes outward for the constant, innermost first", () => {
    const src = [
      "module Billing",
      "  class Caller",
      "    def go",
      "      Service.new(Firm.new)",
      "    end",
      "  end",
      "end",
      "",
    ].join("\n");
    const ex = exWith(src, [
      { symbolId: "Billing::Caller#go", startLine: 3, endLine: 5, scope: ["Billing", "Caller"] },
    ]);
    expect(ex.knownTargetCallArgs?.[0]?.targets).toEqual([
      "Billing::Caller::Service#initialize",
      "Billing::Service#initialize",
      "Service#initialize",
    ]);
  });

  it("a constant-receiver factory verb targets the CLASS-form coordinate", () => {
    const src = ["class Caller", "  def go", "    Service.build(Firm.new)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 4, scope: ["Caller"] }]);
    const forService = ex.knownTargetCallArgs?.find((r) => r.targets.includes("Service.build"));
    expect(forService?.argTypes).toEqual([{ form: "instance", name: "Firm" }]);
  });

  it("a non-constant receiver is NOT a known target", () => {
    const src = ["class Caller", "  def go", "    factory.new(Firm.new)", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "Caller#go", startLine: 2, endLine: 4, scope: ["Caller"] }]);
    expect(ex.knownTargetCallArgs).toBeUndefined();
  });
});

describe("ruby walker — class-field param links (bvalc)", () => {
  it("links `@firm = firm` to the initialize parameter it copies", () => {
    const src = ["class A", "  def initialize(firm)", "    @firm = firm", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "A#initialize", startLine: 2, endLine: 4, scope: ["A"] }]);
    expect(ex.classFieldParamLinks).toEqual({ A: { "@firm": { method: "initialize", param: "firm" } } });
  });

  it("does NOT link an ivar fed by a local that merely shares the scope", () => {
    const src = ["class A", "  def initialize(firm)", "    tmp = compute", "    @thing = tmp", "  end", "end", ""].join(
      "\n",
    );
    const ex = exWith(src, [{ symbolId: "A#initialize", startLine: 2, endLine: 5, scope: ["A"] }]);
    expect(ex.classFieldParamLinks?.A?.["@thing"]).toBeUndefined();
  });

  it("drops an ivar fed from two different parameter origins", () => {
    const src = [
      "class A",
      "  def initialize(firm)",
      "    @thing = firm",
      "  end",
      "  def reset(other)",
      "    @thing = other",
      "  end",
      "end",
      "",
    ].join("\n");
    const ex = exWith(src, [
      { symbolId: "A#initialize", startLine: 2, endLine: 4, scope: ["A"] },
      { symbolId: "A#reset", startLine: 5, endLine: 7, scope: ["A"] },
    ]);
    expect(ex.classFieldParamLinks?.A?.["@thing"]).toBeUndefined();
  });

  it("keeps an ivar assigned from the same parameter twice", () => {
    const src = ["class A", "  def initialize(firm)", "    @firm = firm", "    @firm = firm", "  end", "end", ""].join(
      "\n",
    );
    const ex = exWith(src, [{ symbolId: "A#initialize", startLine: 2, endLine: 5, scope: ["A"] }]);
    expect(ex.classFieldParamLinks?.A?.["@firm"]).toEqual({ method: "initialize", param: "firm" });
  });

  it("skips class-method ivars — `@x` in `def self.m` is a different storage slot", () => {
    const src = ["class A", "  def self.build(firm)", "    @firm = firm", "  end", "end", ""].join("\n");
    const ex = exWith(src, [{ symbolId: "A.build", startLine: 2, endLine: 4, scope: ["A"] }]);
    expect(ex.classFieldParamLinks).toBeUndefined();
  });

  it("qualifies the class key by its full lexical scope", () => {
    const src = [
      "module Billing",
      "  class Service",
      "    def initialize(firm)",
      "      @firm = firm",
      "    end",
      "  end",
      "end",
      "",
    ].join("\n");
    const ex = exWith(src, [
      { symbolId: "Billing::Service#initialize", startLine: 3, endLine: 5, scope: ["Billing", "Service"] },
    ]);
    expect(ex.classFieldParamLinks).toEqual({
      "Billing::Service": { "@firm": { method: "initialize", param: "firm" } },
    });
  });
});
