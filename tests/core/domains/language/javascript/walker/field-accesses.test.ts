/**
 * JavaScript field accesses (bd tea-rags-mcp-p1w1c, zy6hx follow-up) — the
 * `FileExtraction.fieldAccesses` facts the shared ECMAScript field-access facet
 * pass publishes for JavaScript, read through the seam production runs:
 * materialize, `collectSymbols(tree, walker.nameOf, …)`, then the COMPOSED
 * `walker.walk`. Mirrors the TypeScript cases that apply; JavaScript writes no
 * type annotations, so a parameter owner is always `unknown` with its receiver.
 */
import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavaScriptLanguage } from "../../../../../../src/core/domains/language/javascript/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import { buildFieldAccessRows } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/field-access-rows.js";

const tsGrammar = (TsLang as unknown as { typescript: unknown }).typescript;

function extractWith(
  language: JavaScriptLanguage | TypeScriptLanguage,
  grammar: unknown,
  src: string,
  relPath: string,
  languageName: string,
): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(grammar as Parser.Language);
  const tree = { rootNode: materializeTree(parser.parse(src).rootNode, src) };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath, language: languageName, chunks });
}

function extract(src: string): FileExtraction {
  return extractWith(new JavaScriptLanguage(), JsLang, src, "a.js", "javascript");
}

function accessesOf(...lines: string[]) {
  return extract(lines.join("\n")).fieldAccesses ?? [];
}

// One pass, two grammars: on untyped source both languages must publish the
// SAME facts. The expected facts and their count are derived from the
// TypeScript pass, not hand-written, so a divergence in either grammar's
// handling shows up here.
const SHARED_UNTYPED_SOURCES: readonly string[] = [
  [
    "class A {",
    "  #p = 0;",
    "  static s = 1;",
    "  constructor(x) { this.x = x; this.#p = x.v; }",
    "  m(q) { this.#p += q.n; A.s = this.x; }",
    "  static k() { return this.s; }",
    "}",
  ].join("\n"),
  [
    "class B {",
    "  c = 0;",
    "  get g() { const { a, b } = this; return a + b; }",
    "  set g(v) { [this.a] = v; }",
    "}",
  ].join("\n"),
  [
    "class C {",
    "  run(p, o = {}, ...rest) {",
    "    [1].map((p) => p.z);",
    "    return p.y + o.w + this.u.v.w;",
    "  }",
    "}",
  ].join("\n"),
];

describe("JavaScript walker — field accesses", () => {
  it("records this.x reads and writes as self accesses owned by the enclosing class", () => {
    expect(
      accessesOf(
        "class Cart {", //
        "  total() {",
        "    this.count = this.items;",
        "    return this.count;",
        "  }",
        "}",
      ),
    ).toEqual([
      {
        symbolId: "Cart#total",
        ownerKind: "self",
        ownerType: "Cart",
        fieldName: "count",
        accessKind: "write",
        line: 3,
      },
      { symbolId: "Cart#total", ownerKind: "self", ownerType: "Cart", fieldName: "items", accessKind: "read", line: 3 },
      { symbolId: "Cart#total", ownerKind: "self", ownerType: "Cart", fieldName: "count", accessKind: "read", line: 4 },
    ]);
  });

  it("records a compound assignment and an update as a read followed by a write", () => {
    const facts = accessesOf(
      "class Counter {",
      "  bump() {",
      "    this.n += 1;",
      "    this.m++;",
      "    this.cache ??= {};",
      "    this.flag ||= true;",
      "    this.ok &&= false;",
      "  }",
      "}",
    );
    expect(facts.map((f) => [f.fieldName, f.accessKind, f.line])).toEqual([
      ["n", "read", 3],
      ["n", "write", 3],
      ["m", "read", 4],
      ["m", "write", 4],
      ["cache", "read", 5],
      ["cache", "write", 5],
      ["flag", "read", 6],
      ["flag", "write", 6],
      ["ok", "read", 7],
      ["ok", "write", 7],
    ]);
  });

  it("keeps the sigil of an ES2022 private field on this.#x reads and writes", () => {
    const facts = accessesOf(
      "class Vault {",
      "  #secret = 1;",
      "  open() {",
      "    this.#secret = this.#secret + 1;",
      "    return this.#secret;",
      "  }",
      "}",
    );
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.ownerType, f.fieldName, f.accessKind, f.line])).toEqual([
      ["Vault#open", "self", "Vault", "#secret", "write", 4],
      ["Vault#open", "self", "Vault", "#secret", "read", 4],
      ["Vault#open", "self", "Vault", "#secret", "read", 5],
    ]);
  });

  it("records static access through the class name and this in a static method as class accesses", () => {
    const facts = accessesOf(
      "class Registry {",
      "  static instances = 0;",
      "  static create() {",
      "    this.instances += 1;",
      "  }",
      "  register() {",
      "    Registry.instances = 2;",
      "  }",
      "}",
    );
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.ownerType, f.fieldName, f.accessKind])).toEqual([
      ["Registry.create", "class", "Registry", "instances", "read"],
      ["Registry.create", "class", "Registry", "instances", "write"],
      ["Registry#register", "class", "Registry", "instances", "write"],
    ]);
  });

  it("records a parameter's field as unknown with the receiver and no owner type", () => {
    expect(accessesOf("class Mailer {", "  send(order) {", "    order.sent = true;", "  }", "}")).toEqual([
      {
        symbolId: "Mailer#send",
        ownerKind: "unknown",
        receiver: "order",
        fieldName: "sent",
        accessKind: "write",
        line: 3,
      },
    ]);
  });

  it("treats a default-valued parameter as a named receiver; a destructured or rest one names none", () => {
    const facts = accessesOf(
      "class Mailer {",
      "  send(order = {}, { to }, ...rest) {",
      "    return order.email + to.name + rest.length;",
      "  }",
      "}",
    );
    expect(facts.map((f) => [f.ownerKind, f.receiver, f.fieldName])).toEqual([["unknown", "order", "email"]]);
  });

  it("records nothing for locals, module values, imports, or hops past the first", () => {
    const facts = accessesOf(
      "import { config } from './config';",
      "const shared = { a: 1 };",
      "class Svc {",
      "  run(p) {",
      "    const local = new Thing();",
      "    local.x = config.y + shared.a;",
      "    return this.repo.items.length + p.body.size;",
      "  }",
      "}",
    );
    expect(facts.map((f) => [f.ownerKind, f.fieldName])).toEqual([
      ["self", "repo"],
      ["unknown", "body"],
    ]);
  });

  it("skips a member that is the callee of a call, and reads x in this.x.m()", () => {
    const facts = accessesOf(
      "class Svc {",
      "  run(p) {",
      "    this.helper();",
      "    this.#tick();",
      "    p.send();",
      "    this.repo.save();",
      "  }",
      "  #tick() {}",
      "  helper() {}",
      "}",
    );
    expect(facts.map((f) => [f.fieldName, f.accessKind])).toEqual([["repo", "read"]]);
  });

  it("skips this inside a nested function or class expression, keeps it inside an arrow", () => {
    const facts = accessesOf(
      "class Svc {",
      "  run(p) {",
      "    function inner() { return this.a; }",
      "    const k = class { m() { return this.b; } };",
      "    const o = { m() { return this.c; } };",
      "    [1].forEach(() => this.d);",
      "    [1].forEach(function () { return p.e; });",
      "  }",
      "}",
    );
    expect(facts.filter((f) => f.symbolId === "Svc#run").map((f) => f.fieldName)).toEqual(["d", "e"]);
    expect(facts.filter((f) => f.symbolId !== "Svc#run")).toEqual([
      { symbolId: "Svc#run.k#m", ownerKind: "unknown", fieldName: "b", accessKind: "read", line: 4 },
    ]);
  });

  it("does not treat a nested function's own parameter as the method's parameter", () => {
    const facts = accessesOf(
      "class Svc {",
      "  run(p) {",
      "    [1].map((p) => p.shadowed);",
      "    [1].map(p => p.bare);",
      "    return p.kept;",
      "  }",
      "}",
    );
    expect(facts.map((f) => f.fieldName)).toEqual(["kept"]);
  });

  // Diverges from TypeScript on purpose: no chunk carries a JavaScript
  // class-property function (`classPropertyFunction` answers only TypeScript's
  // `public_field_definition`, bd tea-rags-mcp-5ldqu), so no member id owns
  // these accesses and none are guessed onto the class.
  it("records nothing inside a class-field arrow function, which owns no chunk in JavaScript", () => {
    const extraction = extract(
      ["class View {", "  onClick = (e) => {", "    this.clicks = e.detail;", "  };", "}"].join("\n"),
    );
    expect(extraction.chunks.map((c) => c.symbolId)).not.toContain("View#onClick");
    expect(extraction.fieldAccesses ?? []).toEqual([]);
  });

  it("records constructor this.x assignments and accessor reads", () => {
    const facts = accessesOf(
      "class Box {",
      "  constructor(size) {",
      "    this.size = size;",
      "  }",
      "  get area() {",
      "    return this.size;",
      "  }",
      "}",
    );
    expect(facts.map((f) => [f.symbolId, f.fieldName, f.accessKind])).toEqual([
      ["Box#constructor", "size", "write"],
      ["Box#area", "size", "read"],
    ]);
  });

  it("records each property destructured out of this as a read", () => {
    const facts = accessesOf("class Svc {", "  run() {", "    const { a, b: renamed, ...rest } = this;", "  }", "}");
    expect(facts.map((f) => [f.ownerKind, f.fieldName, f.accessKind, f.line])).toEqual([
      ["self", "a", "read", 3],
      ["self", "b", "read", 3],
    ]);
  });

  it("records a member written through a destructuring assignment target as a write", () => {
    const facts = accessesOf("class Svc {", "  run(q) {", "    [this.h] = q;", "  }", "}");
    expect(facts.map((f) => [f.fieldName, f.accessKind])).toEqual([["h", "write"]]);
  });

  it("records nothing outside class methods: top-level code, field initializers, constructor-function prototypes", () => {
    const facts = accessesOf(
      "function free(p) { return p.body; }",
      "class Svc {",
      "  derived = this.base;",
      "}",
      "function Legacy(n) { this.n = n; }",
      "Legacy.prototype.get = function () { return this.n; };",
      "export const v = globalThis.x;",
    );
    expect(facts).toEqual([]);
  });

  it("attributes every access of an oversized method to the method's base id, never a #partN", () => {
    const body = Array.from({ length: 400 }, (_, i) => `    this.f${i} = this.g${i} + ${i};`);
    const facts = accessesOf("class Big {", "  run() {", ...body, "  }", "}");
    expect(facts).toHaveLength(800);
    expect(new Set(facts.map((f) => f.symbolId))).toEqual(new Set(["Big#run"]));
  });

  it("reaches cg_symbols_edges_field rows through buildFieldAccessRows", () => {
    const extraction = extract(
      ["class Cart {", "  add() {", "    this.n += 1;", "    this.n += 2;", "  }", "}"].join("\n"),
    );
    expect(buildFieldAccessRows(extraction)).toEqual([
      expect.objectContaining({
        sourceSymbolId: "Cart#add",
        ownerKind: "self",
        ownerType: "Cart",
        fieldName: "n",
        accessKind: "read",
        accessCount: 2,
        firstLine: 3,
      }),
      expect.objectContaining({
        sourceSymbolId: "Cart#add",
        ownerKind: "self",
        ownerType: "Cart",
        fieldName: "n",
        accessKind: "write",
        accessCount: 2,
        firstLine: 3,
      }),
    ]);
  });

  it.each(SHARED_UNTYPED_SOURCES.map((src, i) => [i, src] as const))(
    "publishes exactly the TypeScript pass's facts, count derived from it, for shared untyped source #%i",
    (_i, src) => {
      const js = extract(src).fieldAccesses ?? [];
      const ts = extractWith(new TypeScriptLanguage(), tsGrammar, src, "a.ts", "typescript").fieldAccesses ?? [];
      expect(ts.length).toBeGreaterThan(0);
      expect(js).toHaveLength(ts.length);
      expect(js).toEqual(ts);
    },
  );
});
