/**
 * TypeScript field accesses (bd tea-rags-mcp-zy6hx, D0 T2) — the
 * `FileExtraction.fieldAccesses` facts the field-access facet pass publishes,
 * read through the seam production runs: materialize, `collectSymbols(tree,
 * walker.nameOf, …)`, then the COMPOSED `walker.walk`, so the owner join
 * against real chunk ids is what is asserted.
 */
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import { buildFieldAccessRows } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/field-access-rows.js";

const grammar = (TsLang as unknown as { typescript: unknown }).typescript;

function extract(src: string): FileExtraction {
  const language = new TypeScriptLanguage();
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
  return language.walker.walk({ tree, code: src, relPath: "a.ts", language: "typescript", chunks });
}

function accessesOf(...lines: string[]) {
  return extract(lines.join("\n")).fieldAccesses ?? [];
}

describe("TypeScript walker — field accesses", () => {
  it("records this.x reads and writes as self accesses owned by the enclosing class", () => {
    expect(
      accessesOf(
        "class Cart {", //
        "  total(): number {",
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

  it("keeps the sigil of an ECMAScript private field", () => {
    const facts = accessesOf("class Vault {", "  #secret = 1;", "  open() {", "    return this.#secret;", "  }", "}");
    expect(facts).toEqual([
      {
        symbolId: "Vault#open",
        ownerKind: "self",
        ownerType: "Vault",
        fieldName: "#secret",
        accessKind: "read",
        line: 4,
      },
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

  it("records a typed parameter's field as a param access carrying the raw type name and the receiver", () => {
    expect(accessesOf("class Mailer {", "  send(order: Order<Line>) {", "    return order.email;", "  }", "}")).toEqual(
      [
        {
          symbolId: "Mailer#send",
          ownerKind: "param",
          ownerType: "Order",
          receiver: "order",
          fieldName: "email",
          accessKind: "read",
          line: 3,
        },
      ],
    );
  });

  it("records an untyped parameter's field as unknown with the receiver and no owner type", () => {
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

  it("records nothing for locals, module values, imports, or hops past the first", () => {
    const facts = accessesOf(
      "import { config } from './config';",
      "const shared = { a: 1 };",
      "class Svc {",
      "  run(p: Req) {",
      "    const local = new Thing();",
      "    local.x = config.y + shared.a;",
      "    return this.repo.items.length + p.body.size;",
      "  }",
      "}",
    );
    expect(facts.map((f) => [f.ownerKind, f.fieldName])).toEqual([
      ["self", "repo"],
      ["param", "body"],
    ]);
  });

  it("skips a member that is the callee of a call, and reads x in this.x.m()", () => {
    const facts = accessesOf(
      "class Svc {",
      "  run(p: Req) {",
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
      "  run(p: Req) {",
      "    function inner() { return this.a; }",
      "    const k = class { m() { return this.b; } };",
      "    const o = { m() { return this.c; } };",
      "    [1].forEach(() => this.d);",
      "    [1].forEach(function () { return p.e; });",
      "  }",
      "}",
    );
    expect(facts.filter((f) => f.symbolId === "Svc#run").map((f) => f.fieldName)).toEqual(["d", "e"]);
    // The class expression's method is a member of its own (anonymous) class: its
    // `this` is that class's instance, never the outer `Svc`.
    expect(facts.filter((f) => f.symbolId !== "Svc#run")).toEqual([
      { symbolId: "Svc#run.k#m", ownerKind: "unknown", fieldName: "b", accessKind: "read", line: 4 },
    ]);
  });

  it("does not treat a nested function's own parameter as the method's parameter", () => {
    const facts = accessesOf(
      "class Svc {",
      "  run(p: Req) {",
      "    [1].map((p) => p.shadowed);",
      "    return p.kept;",
      "  }",
      "}",
    );
    expect(facts.map((f) => f.fieldName)).toEqual(["kept"]);
  });

  it("attributes a class-property arrow function's accesses and params to the property's method id", () => {
    const facts = accessesOf(
      "class View {",
      "  onClick = (e: MouseEvent) => {",
      "    this.clicks = e.detail;",
      "  };",
      "}",
    );
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.ownerType, f.fieldName, f.accessKind])).toEqual([
      ["View#onClick", "self", "View", "clicks", "write"],
      ["View#onClick", "param", "MouseEvent", "detail", "read"],
    ]);
  });

  it("records constructor and accessor accesses", () => {
    const facts = accessesOf(
      "class Box {",
      "  constructor(size: number) {",
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
    const facts = accessesOf("class Svc {", "  run(q: number[]) {", "    [this.h] = q;", "  }", "}");
    expect(facts.map((f) => [f.fieldName, f.accessKind])).toEqual([["h", "write"]]);
  });

  it("records nothing outside class methods: top-level code and field initializers", () => {
    const facts = accessesOf(
      "function free(p: Req) { return p.body; }",
      "class Svc {",
      "  derived = this.base;",
      "}",
      "export const v = (globalThis as any).x;",
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
});
