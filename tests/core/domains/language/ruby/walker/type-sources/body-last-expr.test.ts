/**
 * G2 — Service `call` / `perform` body last-expression RETURN-type source.
 *
 * `walker/type-sources/body-last-expr.ts` inspects the LAST expression of a
 * service-entry method body (convention-gated to `call` / `perform`, instance or
 * class form) and emits a `kind:"return"` fact ONLY for conservative shapes:
 *
 *   - `Const.new(...)`                         → instance(Const)
 *   - `Const.new(...).freeze` / `.tap { }` tail → instance(Const)
 *   - a local var whose LAST (single) assignment is `Const.new(...)` → instance(Const)
 *
 * Everything else (branching returns, method-call tails, ternaries, reassigned
 * locals, non-const `new` receivers) → SILENCE. A wrong return type poisons every
 * chain hop, so precision beats recall.
 *
 * Precedence (DEFAULT_SOURCE_ORDER): yard > associations > body-last-expr. A YARD
 * `@return` (or a macro-declared association type) on the same coordinate wins.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { RubyTypeFactStore } from "../../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import { rubyBodyLastExprTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/body-last-expr.js";
import { rubyYardTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
import {
  extractFromRubyFile,
  type RubyExtractInput,
} from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function makeInput(code: string): RubyExtractInput {
  return { code, relPath: "test.rb", language: "ruby", tree: parse(code), chunks: [] };
}

/** All `kind:"return"` facts the source emits for `code`. */
function returnFacts(code: string) {
  return rubyBodyLastExprTypeSource.extract(makeInput(code)).filter((f) => f.kind === "return");
}

/** The single fact emitted for a method, or undefined. */
function factFor(code: string, method: string) {
  return returnFacts(code).find((f) => f.methodName === method);
}

describe("rubyBodyLastExprTypeSource — conservative emitting shapes", () => {
  it("`Const.new(...)` tail on instance `#call` → instance(Const)", () => {
    const fact = factFor(["class BuildReport", "  def call", "    Result.new(data)", "  end", "end"].join("\n"), "call");
    expect(fact?.symbolScope).toEqual(["BuildReport"]);
    expect(fact?.type).toEqual({ form: "instance", name: "Result" });
    expect(fact?.source).toBe("body-last-expr");
  });

  it("`Const.new(...).freeze` tail → instance(Const) (freeze returns the receiver)", () => {
    const fact = factFor(["class Svc", "  def call", "    Result.new(x).freeze", "  end", "end"].join("\n"), "call");
    expect(fact?.type).toEqual({ form: "instance", name: "Result" });
  });

  it("`Const.new(...).tap { }` tail → instance(Const) (tap returns the receiver)", () => {
    const fact = factFor(
      ["class Svc", "  def call", "    Result.new(x).tap { |r| r.log }", "  end", "end"].join("\n"),
      "call",
    );
    expect(fact?.type).toEqual({ form: "instance", name: "Result" });
  });

  it("single-assignment local var whose last assignment is `Const.new(...)` → instance(Const)", () => {
    const fact = factFor(
      ["class Svc", "  def call", "    result = Result.new(x)", "    result", "  end", "end"].join("\n"),
      "call",
    );
    expect(fact?.type).toEqual({ form: "instance", name: "Result" });
  });

  it("explicit `return Const.new(...)` → instance(Const)", () => {
    const fact = factFor(["class Svc", "  def call", "    return Result.new(x)", "  end", "end"].join("\n"), "call");
    expect(fact?.type).toEqual({ form: "instance", name: "Result" });
  });

  it("class-form `def self.call` → emits, attributed to the enclosing scope", () => {
    const fact = factFor(["class Svc", "  def self.call(x)", "    Result.new(x)", "  end", "end"].join("\n"), "call");
    expect(fact?.symbolScope).toEqual(["Svc"]);
    expect(fact?.type).toEqual({ form: "instance", name: "Result" });
  });

  it("instance `#perform` (job convention) → emits", () => {
    const fact = factFor(["class Job", "  def perform(a)", "    Result.new", "  end", "end"].join("\n"), "perform");
    expect(fact?.type).toEqual({ form: "instance", name: "Result" });
  });

  it("nested module scope is fully qualified", () => {
    const fact = factFor(
      ["module Acme", "  class Svc", "    def call", "      Result.new", "    end", "  end", "end"].join("\n"),
      "call",
    );
    expect(fact?.symbolScope).toEqual(["Acme", "Svc"]);
  });
});

describe("rubyBodyLastExprTypeSource — silence gates (precision, never fabricate)", () => {
  it("branching (if/else divergent) tail → NO fact", () => {
    const code = [
      "class Svc",
      "  def call",
      "    if ok?",
      "      Success.new",
      "    else",
      "      Failure.new",
      "    end",
      "  end",
      "end",
    ].join("\n");
    expect(factFor(code, "call")).toBeUndefined();
  });

  it("opaque method-call tail (delegates to another service) → NO fact", () => {
    expect(factFor(["class Svc", "  def call", "    OtherService.call(x)", "  end", "end"].join("\n"), "call")).toBeUndefined();
  });

  it("bare method-call tail (no receiver, not a local) → NO fact", () => {
    expect(factFor(["class Svc", "  def call", "    build_result", "  end", "end"].join("\n"), "call")).toBeUndefined();
  });

  it("ternary tail → NO fact", () => {
    expect(
      factFor(["class Svc", "  def call", "    ok? ? Success.new : Failure.new", "  end", "end"].join("\n"), "call"),
    ).toBeUndefined();
  });

  it("reassigned local (two plain assignments) → NO fact", () => {
    const code = [
      "class Svc",
      "  def call",
      "    result = Result.new(x)",
      "    result = Other.new",
      "    result",
      "  end",
      "end",
    ].join("\n");
    expect(factFor(code, "call")).toBeUndefined();
  });

  it("local reassigned via `+=` after a `Const.new` → NO fact", () => {
    const code = [
      "class Svc",
      "  def call",
      "    result = Result.new(x)",
      "    result += 1",
      "    result",
      "  end",
      "end",
    ].join("\n");
    expect(factFor(code, "call")).toBeUndefined();
  });

  it("local reassigned inside a block (shares method scope) → NO fact", () => {
    const code = [
      "class Svc",
      "  def call",
      "    result = Result.new(x)",
      "    items.each { result = Other.new }",
      "    result",
      "  end",
      "end",
    ].join("\n");
    expect(factFor(code, "call")).toBeUndefined();
  });

  it("lone `||=` conditional assignment → NO fact (nil branch, not a clean single-assign)", () => {
    const code = ["class Svc", "  def call", "    result ||= Result.new(x)", "    result", "  end", "end"].join("\n");
    expect(factFor(code, "call")).toBeUndefined();
  });

  it("non-const `new` receiver (`foo.new`) → NO fact", () => {
    expect(factFor(["class Svc", "  def call", "    foo.new(x)", "  end", "end"].join("\n"), "call")).toBeUndefined();
  });

  it("local var tail with a non-typeable RHS → NO fact", () => {
    const code = ["class Svc", "  def call", "    result = compute(x)", "    result", "  end", "end"].join("\n");
    expect(factFor(code, "call")).toBeUndefined();
  });
});

describe("rubyBodyLastExprTypeSource — convention gate (O(service defs), not O(all methods))", () => {
  it("a method NOT named call/perform is never inspected, even when its body ends in `Const.new`", () => {
    const code = ["class Svc", "  def build", "    Result.new(x)", "  end", "end"].join("\n");
    expect(returnFacts(code)).toHaveLength(0);
  });

  it("emits at most ONE fact per gated method (no double-emit for the same coordinate)", () => {
    const code = ["class Svc", "  def call", "    result = Result.new(x)", "    result", "  end", "end"].join("\n");
    const forCall = returnFacts(code).filter((f) => f.methodName === "call" && f.symbolScope.join("::") === "Svc");
    expect(forCall).toHaveLength(1);
  });
});

describe("rubyBodyLastExprTypeSource — store precedence", () => {
  it("YARD `@return` on the same `call` wins over body-last-expr inference", () => {
    const code = [
      "class Svc",
      "  # @return [Admin]",
      "  def call",
      "    Result.new(x)",
      "  end",
      "end",
    ].join("\n");
    const input = makeInput(code);
    const facts = [...rubyYardTypeSource.extract(input), ...rubyBodyLastExprTypeSource.extract(input)];
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["Svc#call"]).toEqual({ form: "instance", name: "Admin" });
  });

  it("associations fact wins over a body-last-expr fact at the same coordinate (order invariant)", () => {
    // No natural collision (associations only fires on macro accessors, body-last-expr
    // only on call/perform), so the ORDER is pinned directly at the store.
    const facts = [
      {
        kind: "return" as const,
        source: "body-last-expr",
        symbolScope: ["Svc"],
        methodName: "call",
        type: { form: "instance" as const, name: "FromBody" },
      },
      {
        kind: "return" as const,
        source: "associations",
        symbolScope: ["Svc"],
        methodName: "call",
        type: { form: "instance" as const, name: "FromAssoc" },
      },
    ];
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["Svc#call"]).toEqual({ form: "instance", name: "FromAssoc" });
  });
});

describe("rubyBodyLastExprTypeSource — registered end-to-end + local-bindings boundary", () => {
  it("extractFromRubyFile surfaces the service return type in structuredReturnTypes", () => {
    const code = ["class BuildReport", "  def call", "    Result.new(data)", "  end", "end"].join("\n");
    const r = extractFromRubyFile({ tree: parse(code), code, relPath: "app/services/build_report.rb", language: "ruby", chunks: [] });
    expect(r.structuredReturnTypes?.["BuildReport#call"]).toEqual({ form: "instance", name: "Result" });
  });

  it("structured (precise, scope-keyed) and flat functionReturnTypes channels AGREE on the same shape", () => {
    // collectRubyBodyReturnTypes fills the FLAT `functionReturnTypes["call"]` for the
    // same `Const.new` tail; body-last-expr fills the PRECISE `structuredReturnTypes`.
    // Different channels, no store double-emit — the resolver prefers structured.
    const code = ["class BuildReport", "  def call", "    Result.new(data)", "  end", "end"].join("\n");
    const r = extractFromRubyFile({ tree: parse(code), code, relPath: "app/services/build_report.rb", language: "ruby", chunks: [] });
    expect(r.structuredReturnTypes?.["BuildReport#call"]).toEqual({ form: "instance", name: "Result" });
    expect(r.functionReturnTypes?.["call"]).toBe("Result");
  });
});
