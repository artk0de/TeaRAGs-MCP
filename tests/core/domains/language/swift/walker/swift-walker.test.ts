/**
 * Swift extraction walker — the tier-2 half of the Swift vertical (imports,
 * calls, localBindings, classFieldTypes) plus `swiftNameOf`, exercised through
 * the REAL tree-sitter-swift grammar.
 *
 * Two things make Swift's node shapes non-obvious enough to pin here:
 *   - ONE `class_declaration` node covers class / struct / enum / extension /
 *     actor, and an extension's `name` field is a `user_type` where a class's
 *     is a `type_identifier`;
 *   - optional chaining and force unwrap put `?` / `!` INSIDE the receiver
 *     text, so an un-normalized receiver never matches a binding.
 *
 * The symbolId cases are a CONVERGENCE gate, not a naming preference: the
 * chunker composes the same ids from the generic engine
 * (`tests/core/domains/language/swift/chunker.test.ts`), and an id the two
 * halves spell differently yields edges pointing at ids no chunk carries.
 */

import Parser from "tree-sitter";
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { swiftNameOf } from "../../../../../../src/core/domains/language/swift/walker/name-of.js";
import { extractFromSwiftFile } from "../../../../../../src/core/domains/language/swift/walker/walker.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage((SwiftLang as { default?: unknown }).default ?? SwiftLang);
  return p.parse(src);
}

/** The whole file as one chunk — enough for tests that only care about call/binding content. */
function wholeFileChunk(src: string, symbolId = "f", scope: string[] = []) {
  return [{ symbolId, scope, startLine: 1, endLine: src.split("\n").length }];
}

function extract(src: string, chunks = wholeFileChunk(src)) {
  return extractFromSwiftFile({
    tree: parse(src),
    code: src,
    relPath: "Sources/Sample.swift",
    language: "swift",
    chunks,
  });
}

/** Composed symbolIds as the codegraph half spells them, via the real kernel composer. */
function codegraphSymbolIds(src: string): string[] {
  return collectSymbols(
    { rootNode: parse(src).rootNode },
    (node) => swiftNameOf(node),
    ".",
    true,
    new DefaultSymbolIdComposer(),
  ).map((s) => s.symbolId);
}

describe("extractFromSwiftFile — imports", () => {
  it("captures a plain module import", () => {
    const r = extract("import Foundation\nfunc go() {}\n");
    expect(r.imports.map((i) => i.importText)).toEqual(["Foundation"]);
  });

  it("captures a submodule / declaration import as its dotted path", () => {
    // `import struct Foundation.Data` — the kind keyword is part of the
    // declaration, never part of the module path.
    const r = extract("import struct Foundation.Data\nfunc go() {}\n");
    expect(r.imports.map((i) => i.importText)).toEqual(["Foundation.Data"]);
  });

  it("ignores an import inside a comment", () => {
    const r = extract("// import Fake\nimport UIKit\nfunc go() {}\n");
    expect(r.imports.map((i) => i.importText)).toEqual(["UIKit"]);
  });
});

describe("extractFromSwiftFile — calls", () => {
  it("records a bare call with a null receiver", () => {
    const src = "func go() {\n  globalFn()\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: null, member: "globalFn" }));
  });

  it("records a navigation call's receiver and member", () => {
    const src = "func go() {\n  repo.persist(x)\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: "repo", member: "persist" }));
  });

  it("records `self.member()` with the bare `self` receiver", () => {
    const src = "func go() {\n  self.helper()\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: "self", member: "helper" }));
  });

  it("records `self.field.member()` with the dotted receiver the field strategy reads", () => {
    const src = "func go() {\n  self.db.write(x)\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: "self.db", member: "write" }));
  });

  it("normalizes optional chaining out of the receiver", () => {
    const src = "func go() {\n  obj?.maybe()\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: "obj", member: "maybe" }));
  });

  it("normalizes force unwrap out of the receiver", () => {
    // `obj!` parses as a `postfix_expression`, so the raw receiver text is
    // `obj!` — a binding keyed `obj` would never match it.
    const src = "func go() {\n  obj!.forced()\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: "obj", member: "forced" }));
  });

  it("normalizes a MIXED optional/unwrap chain down to the dotted path", () => {
    const src = "func go() {\n  a?.b!.c()\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: "a.b", member: "c" }));
  });

  it("sees through `try` / `await` wrappers", () => {
    const src = "func go() async throws {\n  try await session.data(for: r)\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: "session", member: "data" }));
  });

  it("records a trailing-closure call", () => {
    const src = "func go() {\n  items.forEach { thing in thing.touch() }\n}\n";
    const r = extract(src);
    expect(r.chunks[0].calls).toContainEqual(expect.objectContaining({ receiver: "items", member: "forEach" }));
  });

  it("does NOT record a subscript access as a call", () => {
    // tree-sitter-swift parses `items[i]` as a `call_expression` whose
    // `call_suffix` is bracketed. It is an index read, not a call — recording
    // it emits a bare call named after a PROPERTY, which the global
    // short-name pass then happily pins to an unrelated function.
    const src = 'func go() {\n  let v = items[i]\n  let w = dict["k"]\n}\n';
    const r = extract(src);
    expect(r.chunks[0].calls.map((c) => c.member)).not.toContain("items");
    expect(r.chunks[0].calls.map((c) => c.member)).not.toContain("dict");
  });

  it("attributes a call to the INNERMOST containing chunk", () => {
    const src = ["class Store {", "  func save() {", "    persist()", "  }", "}", ""].join("\n");
    const r = extract(src, [
      { symbolId: "Store", scope: [], startLine: 1, endLine: 5 },
      { symbolId: "Store#save", scope: ["Store"], startLine: 2, endLine: 4 },
    ]);
    expect(r.chunks[0].calls).toEqual([]);
    expect(r.chunks[1].calls.map((c) => c.member)).toEqual(["persist"]);
  });
});

describe("extractFromSwiftFile — localBindings", () => {
  it("binds a typed parameter to its type", () => {
    const src = ["func go(x: Foo) {", "  x.doIt()", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.x?.[0].type).toBe("Foo");
  });

  it("binds the INTERNAL parameter name, not the external label", () => {
    // `_ invoice: Invoice` — `_` is the call-site label and names nothing
    // inside the body.
    const src = ["func go(_ invoice: Invoice) {", "  invoice.total()", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.invoice?.[0].type).toBe("Invoice");
    expect(r.chunks[0].localBindings?.["_"]).toBeUndefined();
  });

  it("binds a type-annotated local", () => {
    const src = ["func go() {", "  let repo: Repository = build()", "  repo.persist()", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.repo?.[0].type).toBe("Repository");
  });

  it("infers a local's type from a CapWords initializer call", () => {
    const src = ["func go() {", "  var tmp = Helper()", "  tmp.run()", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.tmp?.[0].type).toBe("Helper");
  });

  it("does NOT infer a type from a lowercase initializer call", () => {
    // `makeThing()` is a function, not a type. Its return type is unknowable
    // here, and recording `makeThing` as a type lets the resolver pin the next
    // call to a phantom `makeThing#member`.
    const src = ["func go() {", "  let t = makeThing()", "  t.run()", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.t).toBeUndefined();
  });

  it("unwraps an optional annotation to the wrapped type", () => {
    const src = ["func go(x: Foo?) {", "  x?.doIt()", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.x?.[0].type).toBe("Foo");
  });

  it("reduces a generic annotation to its base type", () => {
    const src = ["func go(s: Set<Foo>) {", "  s.insert(x)", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.s?.[0].type).toBe("Set");
  });

  it("binds NOTHING for an array or dictionary annotation", () => {
    // A `[Thing]` is an Array, not a Thing. `LocalBinding.type` is a bare
    // string with no container slot, so binding the ELEMENT type here would
    // pin `xs.append(...)` to `Thing#append`.
    const src = ["func go(xs: [Thing], d: [String: Foo]) {", "  xs.append(y)", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.xs).toBeUndefined();
    expect(r.chunks[0].localBindings?.d).toBeUndefined();
  });

  it("attributes a parameter binding to the method chunk, not the enclosing type chunk", () => {
    const src = ["class Store {", "  func save(x: Foo) {", "    x.doIt()", "  }", "}", ""].join("\n");
    const r = extract(src, [
      { symbolId: "Store", scope: [], startLine: 1, endLine: 5 },
      { symbolId: "Store#save", scope: ["Store"], startLine: 2, endLine: 4 },
    ]);
    expect(r.chunks[0].localBindings).toBeUndefined();
    expect(r.chunks[1].localBindings?.x?.[0].type).toBe("Foo");
  });

  it("keeps a re-bound name position-aware, one entry per declaration", () => {
    const src = ["func go() {", "  var v: Foo = a()", "  v.one()", "  var v: Bar = b()", "  v.two()", "}", ""].join(
      "\n",
    );
    const r = extract(src);
    expect(r.chunks[0].localBindings?.v?.map((b) => b.type)).toEqual(["Foo", "Bar"]);
    expect(r.chunks[0].localBindings?.v?.map((b) => b.line)).toEqual([2, 4]);
  });
});

describe("extractFromSwiftFile — classFieldTypes", () => {
  it("records an annotated stored property under its type name", () => {
    const src = ["class Store {", "  let db: Database", "  func go() { self.db.write() }", "}", ""].join("\n");
    const r = extract(src);
    expect(r.classFieldTypes?.Store?.db).toBe("Database");
  });

  it("records a stored property whose type comes from a CapWords initializer", () => {
    const src = ["class Store {", "  var cache = Cache()", "  func go() { cache.read() }", "}", ""].join("\n");
    const r = extract(src);
    expect(r.classFieldTypes?.Store?.cache).toBe("Cache");
  });

  it("records struct / enum / actor properties through the same class_declaration node", () => {
    const src = ["struct Invoice {", "  let payer: Party", "}", "actor Worker {", "  let queue: Queue", "}", ""].join(
      "\n",
    );
    const r = extract(src);
    expect(r.classFieldTypes?.Invoice?.payer).toBe("Party");
    expect(r.classFieldTypes?.Worker?.queue).toBe("Queue");
  });

  it("does NOT record an array-typed or untyped literal property", () => {
    const src = ["class Store {", "  var items: [Thing] = []", "  var counter = 0", "}", ""].join("\n");
    expect(extract(src).classFieldTypes?.Store).toBeUndefined();
  });

  it("leaves classFieldTypes absent when no type declares a typed stored property", () => {
    const src = ["class Store {", "  func go() {}", "}", ""].join("\n");
    expect(extract(src).classFieldTypes).toBeUndefined();
  });
});

describe("extractFromSwiftFile — edge cases", () => {
  it("returns an empty extraction for an empty file", () => {
    const r = extract("", []);
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
  });

  it("carries the relPath and language through untouched", () => {
    const r = extract("func go() {}\n");
    expect(r.relPath).toBe("Sources/Sample.swift");
    expect(r.language).toBe("swift");
    expect(r.fileScope).toEqual([]);
  });

  it("extracts what it can from syntactically broken source without throwing", () => {
    // tree-sitter is error-tolerant and so is the walker: a truncated body
    // still yields the import and whatever calls parsed cleanly.
    const src = ["import Foundation", "class Broken {", "  func go( {", "    helper()", ""].join("\n");
    const r = extract(src);
    expect(r.imports.map((i) => i.importText)).toEqual(["Foundation"]);
    expect(r.chunks[0].calls.map((c) => c.member)).toContain("helper");
  });

  it("returns imports and no calls for an imports-only file", () => {
    const r = extract("import Foundation\nimport UIKit\n");
    expect(r.imports).toHaveLength(2);
    expect(r.chunks[0].calls).toEqual([]);
    expect(r.classFieldTypes).toBeUndefined();
  });
});

describe("swiftNameOf — symbolId convergence with the chunker", () => {
  it("composes instance methods with # and static/class funcs with .", () => {
    const ids = codegraphSymbolIds(
      ["class Vehicle {", "  func drive() {}", "  class func makeDefault() {}", "}", ""].join("\n"),
    );
    expect(ids).toContain("Vehicle#drive");
    expect(ids).toContain("Vehicle.makeDefault");
  });

  it("composes an init as an instance member and suffixes overloads with ~N", () => {
    const ids = codegraphSymbolIds(
      ["class Invoice {", "  init(n: String) {}", "  convenience init() {}", "}", ""].join("\n"),
    );
    expect(ids).toContain("Invoice#init");
    expect(ids).toContain("Invoice#init~2");
  });

  it("attributes extension methods to the EXTENDED type", () => {
    const ids = codegraphSymbolIds(["extension Vehicle {", "  func honk() {}", "}", ""].join("\n"));
    expect(ids).toContain("Vehicle#honk");
  });

  it("composes nested types with the scope separator", () => {
    const ids = codegraphSymbolIds(
      ["class Ledger {", "  class Account {", "    func post() {}", "  }", "}", ""].join("\n"),
    );
    expect(ids).toContain("Ledger.Account#post");
  });

  it("composes protocol requirements, instance and static", () => {
    const ids = codegraphSymbolIds(
      ["protocol Shape {", "  func draw()", "  static func supports() -> Bool", "}", ""].join("\n"),
    );
    expect(ids).toContain("Shape#draw");
    expect(ids).toContain("Shape.supports");
  });

  it("composes a top-level function as its bare name", () => {
    expect(codegraphSymbolIds("func formatDecimal(v: Int) {}\n")).toContain("formatDecimal");
  });

  it("emits the container types themselves as symbols", () => {
    const ids = codegraphSymbolIds(["struct Point {", "  func reset() {}", "}", ""].join("\n"));
    expect(ids).toContain("Point");
  });

  it("declines every node it has no symbol for", () => {
    const root = parse("class Box { var v: Int = 0 }\n").rootNode;
    const property = root.descendantsOfType("property_declaration")[0];
    expect(swiftNameOf(property)).toBeNull();
  });
});
