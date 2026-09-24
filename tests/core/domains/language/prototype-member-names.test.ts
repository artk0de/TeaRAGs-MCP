/**
 * A source identifier is a map KEY on the extraction path — a local's name keys
 * `localBindings`, a field's name keys `classFieldTypes`, a class's name keys
 * `classExtends`. Identifiers named like an `Object.prototype` member
 * (`toString`, `constructor`, `__proto__`, `hasOwnProperty`, `valueOf`) must key
 * those records like any other name (bd tea-rags-mcp-f4ce0): a `{}` record
 * resolves `bucket["toString"]` to the inherited function, so `??= []` never
 * fires and `.push` throws — the whole file silently dropped out of the graph
 * (9 files of apache commons-lang, `ToStringBuilder.java` among them).
 *
 * Driven through the production seam — `LanguageFactory` → `collectSymbols` →
 * `walker.walk` — so every language's walker is exercised exactly as the
 * codegraph extractor composes it.
 */
import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

import { resolveLocalBinding } from "../../../../src/core/contracts/types/codegraph-local-binding.js";
import type { FileExtraction } from "../../../../src/core/contracts/types/codegraph.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../src/core/domains/language/index.js";
import { CODEGRAPH_LANGUAGES } from "../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { materializeTree } from "../../../../src/core/infra/materialize.js";

function extract(relPath: string, lines: string[]): FileExtraction {
  const code = `${lines.join("\n")}\n`;
  const config = CODEGRAPH_LANGUAGES[relPath.slice(relPath.lastIndexOf("."))];
  const { walker } = new LanguageFactory({ repoRoot: "/nonexistent" }).create(config.language);
  if (!walker) throw new Error(`no walker for ${config.language}`);
  const parser = new Parser();
  parser.setLanguage(config.loadParser());
  const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
  const chunks = collectSymbols(
    tree,
    (n) => walker.nameOf(n),
    config.scopeSeparator,
    config.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return walker.walk({ tree, code, relPath, language: config.language, chunks });
}

/** Every own key a record carries, across every chunk that has the channel. */
function ownBindingNames(extraction: FileExtraction): Set<string> {
  const names = new Set<string>();
  for (const chunk of extraction.chunks) {
    for (const name of Object.keys(chunk.localBindings ?? {})) names.add(name);
  }
  return names;
}

const PROTOTYPE_NAMES = ["toString", "constructor", "__proto__"] as const;

describe("extraction keys identifiers named like Object.prototype members as own keys (bd tea-rags-mcp-f4ce0)", () => {
  it("Java — locals named toString / constructor / __proto__ are bound, not crashed on", () => {
    const r = extract("src/Foo.java", [
      "class Foo {",
      "  Bar toString;",
      "  Bar __proto__;",
      "  String render() {",
      "    Baz toString = make();",
      "    Baz constructor = make();",
      "    Baz __proto__ = make();",
      "    toString.run();",
      '    return "";',
      "  }",
      "}",
    ]);
    const names = ownBindingNames(r);
    for (const name of PROTOTYPE_NAMES) expect(names.has(name), name).toBe(true);
    for (const field of ["toString", "__proto__"]) {
      expect(r.classFieldTypes?.Foo && Object.hasOwn(r.classFieldTypes.Foo, field), field).toBe(true);
    }
  });

  it("Java — a class named constructor keys its fields as an own entry", () => {
    const r = extract("src/Odd.java", ["class hasOwnProperty {", "  Bar valueOf;", "}"]);
    expect(r.classFieldTypes && Object.hasOwn(r.classFieldTypes, "hasOwnProperty")).toBe(true);
  });

  it("TypeScript — locals named toString / constructor / __proto__ are bound", () => {
    const r = extract("src/foo.ts", [
      "export function render(): void {",
      "  const toString: Baz = make();",
      "  const constructor: Baz = make();",
      "  const __proto__: Baz = make();",
      "  toString.run();",
      "}",
    ]);
    const names = ownBindingNames(r);
    for (const name of PROTOTYPE_NAMES) expect(names.has(name), name).toBe(true);
  });

  it("TypeScript — a field named toString keys classFieldTypes as an own entry", () => {
    const r = extract("src/foo.ts", [
      "export class Foo {",
      "  private toString: Bar;",
      "  private constructor_: Bar;",
      "  run(): void { this.toString.go(); }",
      "}",
    ]);
    expect(r.classFieldTypes?.Foo && Object.hasOwn(r.classFieldTypes.Foo, "toString")).toBe(true);
  });

  it("Python — locals named toString / constructor / __proto__ are bound", () => {
    const r = extract("pkg/foo.py", [
      "def render():",
      "    toString = Baz()",
      "    constructor = Baz()",
      "    __proto__ = Baz()",
      "    toString.run()",
    ]);
    const names = ownBindingNames(r);
    for (const name of PROTOTYPE_NAMES) expect(names.has(name), name).toBe(true);
  });

  it("Python — a class named constructor with a field named toString", () => {
    const r = extract("pkg/foo.py", [
      "class constructor:",
      "    def __init__(self):",
      "        self.toString = Bar()",
      "",
      "class valueOf(constructor):",
      "    pass",
    ]);
    expect(r.classFieldTypes && Object.hasOwn(r.classFieldTypes, "constructor")).toBe(true);
    expect(r.classFieldTypes?.constructor && Object.hasOwn(r.classFieldTypes.constructor, "toString")).toBe(true);
    expect(r.classExtends && Object.hasOwn(r.classExtends, "valueOf")).toBe(true);
  });

  it("Ruby — locals named toString / constructor / __proto__ are bound", () => {
    const r = extract("app/foo.rb", [
      "class Foo",
      "  def render",
      "    constructor = Baz.new",
      "    toString = Baz.new",
      "    __proto__ = Baz.new",
      "    constructor.run",
      "  end",
      "end",
    ]);
    const names = ownBindingNames(r);
    for (const name of PROTOTYPE_NAMES) expect(names.has(name), name).toBe(true);
  });

  it("Go — locals named toString / constructor / __proto__ are bound", () => {
    const r = extract("app/app.go", [
      "package app",
      "func render(toString Baz) {",
      "\tvar constructor Baz",
      "\tvar __proto__ Baz",
      "\ttoString.Run()",
      "\t_, _ = constructor, __proto__",
      "}",
    ]);
    const names = ownBindingNames(r);
    for (const name of PROTOTYPE_NAMES) expect(names.has(name), name).toBe(true);
  });

  it("Rust — locals named toString / constructor / __proto__ are bound", () => {
    const r = extract("src/main.rs", [
      "fn render(toString: Baz) {",
      "  let constructor: Baz = make();",
      "  let __proto__: Baz = make();",
      "  toString.run();",
      "}",
    ]);
    const names = ownBindingNames(r);
    for (const name of PROTOTYPE_NAMES) expect(names.has(name), name).toBe(true);
  });

  it("Swift — locals named toString / constructor / __proto__ are bound", () => {
    const r = extract("Sources/Foo.swift", [
      "func render() {",
      "  let toString: Baz = make()",
      "  let constructor: Baz = make()",
      "  let __proto__: Baz = make()",
      "  toString.run()",
      "}",
    ]);
    const names = ownBindingNames(r);
    for (const name of PROTOTYPE_NAMES) expect(names.has(name), name).toBe(true);
  });
});

describe("resolveLocalBinding reads own entries only (bd tea-rags-mcp-f4ce0)", () => {
  // A record that crossed a JSON spill or a worker boundary has Object.prototype
  // again, so the READ must not see inherited members either.
  const record = JSON.parse('{"x":[{"line":1,"type":"X"}]}') as Record<string, { line: number; type: string }[]>;

  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    it(`an unbound receiver named ${name} resolves to nothing`, () => {
      expect(resolveLocalBinding(record, name, 10)).toBeUndefined();
    });
  }

  it("a bound receiver named constructor still resolves", () => {
    const bound = JSON.parse('{"constructor":[{"line":1,"type":"Baz"}]}') as typeof record;
    expect(resolveLocalBinding(bound, "constructor", 5)?.type).toBe("Baz");
  });
});
