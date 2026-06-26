/**
 * RubyTypeFactStore full-map getters (bd tea-rags-mcp-9bliu).
 *
 * `structuredReturnTypesMap()` / `ivarTypesMap()` build the engine-keyed maps
 * the codegraph resolve orchestrator forwards as `ctx.structuredReturnTypes`
 * / `ctx.ivarTypes` — the PRECISE propagation paths (`type-propagation.ts`).
 * These mirror the point lookups (`structuredReturnType` / `ivarType`) but
 * materialise the whole collection in the engine's key convention:
 *   - return: `"<fqClass>#<method>"` (instance form `#`; return facts carry no
 *     static flag, so `#` always — matching the engine's `recv.name#member`).
 *   - ivar:   `fqClass → "@ivar" → typeName` (bare name via refToName).
 * fqClass = `symbolScope.join("::")`. Source precedence: best source wins.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { RubyTypeFactStore } from "../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import type { RubyTypeFact } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/types.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

describe("RubyTypeFactStore.structuredReturnTypesMap", () => {
  it("empty when no return facts", () => {
    expect(RubyTypeFactStore.fromFacts([]).structuredReturnTypesMap()).toEqual({});
  });

  it("keys instance returns as `<fqClass>#<method>` (:: scope join, # member)", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "return",
        source: "yard",
        symbolScope: ["Acme", "User"],
        methodName: "build",
        type: { form: "instance", name: "Post" },
      },
    ];
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["Acme::User#build"]).toEqual({ form: "instance", name: "Post" });
  });

  it("preserves union / container refs intact (not flattened)", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "return",
        source: "yard",
        symbolScope: ["C"],
        methodName: "all",
        type: { form: "container", element: { form: "instance", name: "Post" } },
      },
      {
        kind: "return",
        source: "yard",
        symbolScope: ["C"],
        methodName: "resolve",
        type: {
          form: "union",
          members: [
            { form: "instance", name: "Foo" },
            { form: "instance", name: "Bar" },
          ],
        },
      },
    ];
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["C#all"]).toEqual({ form: "container", element: { form: "instance", name: "Post" } });
    expect(map["C#resolve"]).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "Foo" },
        { form: "instance", name: "Bar" },
      ],
    });
  });

  it("source precedence: yard beats ast at the same `<fqClass>#<method>` key", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "return",
        source: "ast",
        symbolScope: ["A"],
        methodName: "foo",
        type: { form: "instance", name: "AstType" },
      },
      {
        kind: "return",
        source: "yard",
        symbolScope: ["A"],
        methodName: "foo",
        type: { form: "instance", name: "YardType" },
      },
    ];
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["A#foo"]).toEqual({ form: "instance", name: "YardType" });
  });

  it("agrees with the structuredReturnType point lookup per key", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "return",
        source: "yard",
        symbolScope: ["Acme", "User"],
        methodName: "build",
        type: { form: "instance", name: "Post" },
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts);
    expect(store.structuredReturnTypesMap()["Acme::User#build"]).toEqual(
      store.structuredReturnType(["Acme", "User"], "build"),
    );
  });
});

describe("RubyTypeFactStore.ivarTypesMap", () => {
  it("empty when no ivar facts", () => {
    expect(RubyTypeFactStore.fromFacts([]).ivarTypesMap()).toEqual({});
  });

  it("keys `fqClass → @ivar → typeName` (bare name via refToName)", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "ivar",
        source: "yard",
        symbolScope: ["Acme", "User"],
        name: "@account",
        type: { form: "instance", name: "Account" },
      },
    ];
    const map = RubyTypeFactStore.fromFacts(facts).ivarTypesMap();
    expect(map["Acme::User"]).toEqual({ "@account": "Account" });
  });

  it("container ivar reduces to the element name (refToName parity)", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "ivar",
        source: "yard",
        symbolScope: ["C"],
        name: "@posts",
        type: { form: "container", element: { form: "instance", name: "Post" } },
      },
    ];
    expect(RubyTypeFactStore.fromFacts(facts).ivarTypesMap()["C"]).toEqual({ "@posts": "Post" });
  });

  it("union ivar is skipped (no single string name)", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "ivar",
        source: "yard",
        symbolScope: ["C"],
        name: "@x",
        type: {
          form: "union",
          members: [
            { form: "instance", name: "A" },
            { form: "instance", name: "B" },
          ],
        },
      },
    ];
    expect(RubyTypeFactStore.fromFacts(facts).ivarTypesMap()).toEqual({});
  });

  it("source precedence: yard beats ast at the same (fqClass, @ivar)", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "ivar",
        source: "ast",
        symbolScope: ["A"],
        name: "@x",
        type: { form: "instance", name: "AstType" },
      },
      {
        kind: "ivar",
        source: "yard",
        symbolScope: ["A"],
        name: "@x",
        type: { form: "instance", name: "YardType" },
      },
    ];
    expect(RubyTypeFactStore.fromFacts(facts).ivarTypesMap()["A"]).toEqual({ "@x": "YardType" });
  });

  it("multiple ivars on one class collected under one fqClass entry", () => {
    const facts: RubyTypeFact[] = [
      { kind: "ivar", source: "yard", symbolScope: ["A"], name: "@a", type: { form: "instance", name: "Alpha" } },
      { kind: "ivar", source: "yard", symbolScope: ["A"], name: "@b", type: { form: "instance", name: "Beta" } },
    ];
    expect(RubyTypeFactStore.fromFacts(facts).ivarTypesMap()["A"]).toEqual({ "@a": "Alpha", "@b": "Beta" });
  });
});

describe("extractFromRubyFile — forwards the precise type-source maps", () => {
  it("sets structuredReturnTypes from YARD @return facts (engine `Class#method` key form)", () => {
    // bd 9bliu YARD-scope follow-up: YARD inline return facts now carry the
    // enclosing class/module scope, so the structured map keys the member as
    // `Repo#build` (the precise engine `recv.name#member` path) instead of the
    // old flat `#build`. The wiring (walker → FileExtraction.structuredReturnTypes)
    // is what this asserts.
    const src = "class Repo\n  # @return [Post]\n  def build\n    Post.new\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "app/repo.rb", language: "ruby", chunks: [] });
    expect(r.structuredReturnTypes?.["Repo#build"]).toEqual({ form: "instance", name: "Post" });
  });

  it("omits structuredReturnTypes / ivarTypes when there are no facts", () => {
    const src = "x = 1\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "app/empty.rb", language: "ruby", chunks: [] });
    expect(r.structuredReturnTypes).toBeUndefined();
    expect(r.ivarTypes).toBeUndefined();
  });
});
