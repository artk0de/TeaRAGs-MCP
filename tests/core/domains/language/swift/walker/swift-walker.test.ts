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

import { resolveLocalBindingType } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { swiftNameOf } from "../../../../../../src/core/domains/language/swift/walker/name-of.js";
import { extractFromSwiftFile } from "../../../../../../src/core/domains/language/swift/walker/walker.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

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

/**
 * The type a receiver would resolve to at `line`, read the way the resolver
 * reads it — through the kernel's position-aware lookup, never by indexing
 * `localBindings[name]`. Scope extent is only observable through this call, so
 * the `guard let` / `if let` cases assert against it rather than against the
 * raw `scopeEndLine` field alone.
 */
function typeAt(src: string, name: string, line: number): string | undefined {
  return resolveLocalBindingType(extract(src).chunks[0].localBindings, name, line);
}

/** The same extraction off the MATERIALIZED tree — the one the pipeline actually walks. */
function extractMaterialized(src: string, chunks = wholeFileChunk(src)) {
  return extractFromSwiftFile({
    tree: { rootNode: materializeTree(parse(src).rootNode, src) },
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

  it("binds an array annotation as Array and a dictionary one as Dictionary", () => {
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.14): this used to bind NOTHING.
    // A `[Thing]` is an Array, not a Thing — binding the ELEMENT would pin
    // `xs.append(...)` to `Thing#append` — and it IS an Array, whose project
    // extensions (`extension Array where Element == Header`) a call can reach.
    const src = ["func go(xs: [Thing], d: [String: Foo]) {", "  xs.append(y)", "}", ""].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.xs?.[0].type).toBe("Array");
    expect(r.chunks[0].localBindings?.d?.[0].type).toBe("Dictionary");
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

describe("extractFromSwiftFile — optional binding (`guard let` / `if let`)", () => {
  it("types a `guard let` local from the stored property it unwraps", () => {
    const src = [
      "class Store {",
      "  let account: Account",
      "  func go() {",
      "    guard let acct = self.account else { return }",
      "    acct.close()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.acct?.[0].type).toBe("Account");
  });

  it("types a `guard let` local from an IMPLICIT-self property", () => {
    const src = [
      "class Store {",
      "  let account: Account",
      "  func go() {",
      "    guard let acct = account else { return }",
      "    acct.close()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.acct?.[0].type).toBe("Account");
  });

  it("types a `guard let` local from a CapWords initializer", () => {
    const src = ["func go() {", "  guard let h = Helper() else { return }", "  h.run()", "}", ""].join("\n");
    expect(extract(src).chunks[0].localBindings?.h?.[0].type).toBe("Helper");
  });

  it("types a `guard let` local from its own annotation, whatever the right-hand side is", () => {
    const src = ["func go() {", "  guard let x: Foo = lookup() else { return }", "  x.doIt()", "}", ""].join("\n");
    expect(extract(src).chunks[0].localBindings?.x?.[0].type).toBe("Foo");
  });

  it("types a `guard let` local from an already-typed parameter", () => {
    const src = ["func go(p: Foo?) {", "  guard let q = p else { return }", "  q.doIt()", "}", ""].join("\n");
    expect(extract(src).chunks[0].localBindings?.q?.[0].type).toBe("Foo");
  });

  it("keeps a `guard let` binding in scope for the REST of its enclosing block", () => {
    const src = [
      "class Store {",
      "  let backup: Backup",
      "  func go() {",
      "    guard let a = self.backup else { return }",
      "    a.one()",
      "    a.two()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "a", 5)).toBe("Backup");
    expect(typeAt(src, "a", 6)).toBe("Backup");
  });

  it("ends a `guard let` binding with the NESTED block that declares it", () => {
    // A guard unwraps for the rest of its own block — not for the block that
    // contains it. Past the closing brace the name denotes the property again.
    const src = [
      "class Store {",
      "  let backup: Backup",
      "  func go() {",
      "    if flag {",
      "      guard let a = self.backup else { return }",
      "      a.one()",
      "    }",
      "    a.two()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "a", 6)).toBe("Backup");
    expect(typeAt(src, "a", 8)).toBeUndefined();
  });

  it("ends an `if let` binding with its own block", () => {
    const src = [
      "class Store {",
      "  let account: Account",
      "  func go() {",
      "    if let acct = self.account {",
      "      acct.close()",
      "    }",
      "    acct.gone()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "acct", 5)).toBe("Account");
    expect(typeAt(src, "acct", 7)).toBeUndefined();
  });

  it("does NOT carry an `if let` binding into the else branch", () => {
    const src = [
      "class Store {",
      "  let account: Account",
      "  func go() {",
      "    if let acct = self.account {",
      "      acct.close()",
      "    } else {",
      "      acct.gone()",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "acct", 5)).toBe("Account");
    expect(typeAt(src, "acct", 7)).toBeUndefined();
  });

  it("types the `if let x { }` shorthand from the name it re-binds", () => {
    const src = [
      "class Store {",
      "  let account: Account",
      "  func go() {",
      "    if let account {",
      "      account.close()",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "account", 5)).toBe("Account");
  });

  it("scopes a `while let` binding to its own block", () => {
    const src = ["func go() {", "  while let n = Node() {", "    n.use()", "  }", "  n.gone()", "}", ""].join("\n");
    expect(typeAt(src, "n", 3)).toBe("Node");
    expect(typeAt(src, "n", 5)).toBeUndefined();
  });

  it("types every binding of a multi-clause `guard`", () => {
    const src = [
      "class Store {",
      "  let account: Account",
      "  func go() {",
      "    guard let a = self.account, let h = Helper() else { return }",
      "    a.close()",
      "    h.run()",
      "  }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].localBindings;
    expect(bindings?.a?.[0].type).toBe("Account");
    expect(bindings?.h?.[0].type).toBe("Helper");
  });

  it("declines `if case let` — a pattern match binds no single name to a known type", () => {
    const src = ["func go(opt: Wrapper) {", "  if case let .some(v) = opt {", "    v.use()", "  }", "}", ""].join("\n");
    expect(extract(src).chunks[0].localBindings?.v).toBeUndefined();
  });

  it("declines a `guard let` whose right-hand side names no provable type", () => {
    const src = ["func go() {", "  guard let x = lookup() else { return }", "  x.doIt()", "}", ""].join("\n");
    expect(extract(src).chunks[0].localBindings?.x).toBeUndefined();
  });

  it("binds nothing for `guard let self = self`", () => {
    // `self` is a pseudo receiver the chain claims with its own pass; a local
    // binding under that name would make the local-binding pass answer first
    // and DROP what `selfMember` resolves.
    const src = [
      "class Store {",
      "  func go() {",
      "    guard let self = self else { return }",
      "    self.helper()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.self).toBeUndefined();
  });
});

describe("extractFromSwiftFile — call-result locals typed by a same-file declared return", () => {
  it("types a local from a top-level function's declared return type", () => {
    const src = [
      "func make() -> Invoice { Invoice() }",
      "func go() {",
      "  let x = make()",
      "  x.total()",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.x?.[0].type).toBe("Invoice");
  });

  it("types a local from `self.method()`'s declared return type", () => {
    const src = [
      "class Store {",
      "  func build() -> Widget { Widget() }",
      "  func go() {",
      "    let w = self.build()",
      "    w.render()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.w?.[0].type).toBe("Widget");
  });

  it("types a local through a receiver the walker already typed", () => {
    const src = [
      "class Repository {",
      "  func load() -> Invoice { Invoice() }",
      "}",
      "class Store {",
      "  func go(repo: Repository) {",
      "    let x = repo.load()",
      "    x.total()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.x?.[0].type).toBe("Invoice");
  });

  it("lets a member declaration beat a top-level namesake, as Swift lookup does", () => {
    const src = [
      "func make() -> Invoice { Invoice() }",
      "class Store {",
      "  func make() -> Widget { Widget() }",
      "  func go() {",
      "    let x = make()",
      "    x.render()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.x?.[0].type).toBe("Widget");
  });

  it("declines when two same-file overloads declare DIFFERENT return types", () => {
    const src = [
      "func make(a: Int) -> Invoice { Invoice() }",
      "func make(a: String) -> Widget { Widget() }",
      "func go() {",
      "  let x = make(a: 1)",
      "  x.total()",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.x).toBeUndefined();
  });

  it("declines a generic return — the type parameter names no type", () => {
    const src = [
      "func decode<T>() -> T { fatalError() }",
      "func go() {",
      "  let x = decode()",
      "  x.use()",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.x).toBeUndefined();
  });

  it("declines `-> Self` and `-> Void`", () => {
    const src = [
      "class Store {",
      "  func me() -> Self { self }",
      "  func nothing() -> Void {}",
      "  func go() {",
      "    let a = self.me()",
      "    let b = self.nothing()",
      "  }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].localBindings;
    expect(bindings?.a).toBeUndefined();
    expect(bindings?.b).toBeUndefined();
  });

  it("unwraps an optional declared return, and feeds the `guard let` that unwraps it", () => {
    const src = [
      "func find() -> Invoice? { nil }",
      "func go() {",
      "  guard let x = find() else { return }",
      "  x.total()",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.x?.[0].type).toBe("Invoice");
  });

  it("sees through `try` / `await` on the initializer", () => {
    const src = [
      "func load() throws -> Invoice { Invoice() }",
      "func go() async throws {",
      "  let x = try load()",
      "  x.total()",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.x?.[0].type).toBe("Invoice");
  });

  it("binds an array-returning function's result as Array", () => {
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.14), as for an annotation: the
    // local is an Array, not a Thing; it used to bind nothing.
    const src = ["func all() -> [Thing] { [] }", "func go() {", "  let xs = all()", "  xs.append(y)", "}", ""].join(
      "\n",
    );
    expect(extract(src).chunks[0].localBindings?.xs?.[0].type).toBe("Array");
  });
});

describe("extractFromSwiftFile — `for x in` element typing", () => {
  it("types the loop variable from an array-annotated parameter, and the array as Array", () => {
    const src = ["func go(xs: [Thing]) {", "  for x in xs {", "    x.touch()", "  }", "}", ""].join("\n");
    const bindings = extract(src).chunks[0].localBindings;
    expect(bindings?.x?.[0].type).toBe("Thing");
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.14): was undefined.
    expect(bindings?.xs?.[0].type).toBe("Array");
  });

  it("types the loop variable from an array-typed stored property", () => {
    const src = [
      "class Store {",
      "  var items: [Thing] = []",
      "  func go() {",
      "    for item in items {",
      "      item.touch()",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const r = extract(src);
    expect(r.chunks[0].localBindings?.item?.[0].type).toBe("Thing");
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.14): was undefined.
    expect(r.classFieldTypes?.Store?.items).toBe("Array");
  });

  it("types the loop variable from an array-returning same-file function", () => {
    const src = [
      "func all() -> [Thing] { [] }",
      "func go() {",
      "  for x in all() {",
      "    x.touch()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].localBindings?.x?.[0].type).toBe("Thing");
  });

  it("types the loop variable through a `guard let` that unwraps an optional array", () => {
    // Unwrapping `[Thing]?` yields `[Thing]`, so the unwrapped name carries the
    // ELEMENT for the loop and is itself an Array (INVARIANT CHANGED, bd
    // tea-rags-mcp-y99pg.14: it used to bind nothing).
    const src = [
      "class Store {",
      "  var items: [Thing]?",
      "  func go() {",
      "    guard let list = self.items else { return }",
      "    for x in list {",
      "      x.touch()",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].localBindings;
    expect(bindings?.x?.[0].type).toBe("Thing");
    expect(bindings?.list?.[0].type).toBe("Array");
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.17): a `(k, v)` pattern over a
  // DICTIONARY now binds its key and value types; a tuple pattern over
  // anything else still binds nothing. INVARIANT CHANGED again (bd
  // tea-rags-mcp-y99pg.32): a `Set<Thing>` iterates `Thing`s, as the
  // typechecker binds `for x in s` — the old decline was the walker dropping
  // generic arguments, not a claim about Set.
  it("binds a Set's element and a dictionary's key and value; declines a tuple pattern over a non-dictionary", () => {
    const src = [
      "func go(s: Set<Thing>, d: [String: Foo], xs: [Thing]) {",
      "  for x in s { x.touch() }",
      "  for (k, v) in d { v.use() }",
      "  for (i, t) in xs.enumerated() { t.touch() }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].localBindings;
    expect(bindings?.x?.[0].type).toBe("Thing");
    expect(bindings?.k?.[0].type).toBe("String");
    expect(bindings?.v?.[0].type).toBe("Foo");
    expect(bindings?.i).toBeUndefined();
    expect(bindings?.t).toBeUndefined();
  });

  it("scopes the loop variable to the loop body", () => {
    const src = ["func go(xs: [Thing]) {", "  for x in xs {", "    x.touch()", "  }", "  x.gone()", "}", ""].join("\n");
    expect(typeAt(src, "x", 3)).toBe("Thing");
    expect(typeAt(src, "x", 5)).toBeUndefined();
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

  it("records an array-typed property as Array and still no untyped literal property", () => {
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.14): `items` used to be dropped.
    const src = ["class Store {", "  var items: [Thing] = []", "  var counter = 0", "}", ""].join("\n");
    expect(extract(src).classFieldTypes?.Store).toEqual({ items: "Array" });
  });

  it("leaves classFieldTypes absent when no type declares a typed stored property", () => {
    const src = ["class Store {", "  func go() {}", "}", ""].join("\n");
    expect(extract(src).classFieldTypes).toBeUndefined();
  });
});

describe("extractFromSwiftFile — classFieldTypesByClassKey", () => {
  it("publishes the SAME facts under a file-qualified key", () => {
    // The run-global address. `classFieldTypes` is threaded per-FILE, so a
    // resolver in another file cannot see it; this key is what survives the
    // pass-1 → pass-2 barrier.
    const src = ["class Store {", "  let db: Database", "}", ""].join("\n");
    const r = extract(src);
    expect(r.classFieldTypesByClassKey).toEqual({ "Sources/Sample.swift::Store": { db: "Database" } });
  });

  it("keys every type the file declares, not just the first", () => {
    const src = ["struct Invoice {", "  let payer: Party", "}", "actor Worker {", "  let queue: Queue", "}", ""].join(
      "\n",
    );
    const r = extract(src);
    expect(Object.keys(r.classFieldTypesByClassKey ?? {}).sort()).toEqual([
      "Sources/Sample.swift::Invoice",
      "Sources/Sample.swift::Worker",
    ]);
  });

  it("stays absent when the file publishes no field types at all", () => {
    const src = ["class Store {", "  func go() {}", "}", ""].join("\n");
    expect(extract(src).classFieldTypesByClassKey).toBeUndefined();
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

describe("extractFromSwiftFile — the MATERIALIZED tree the pipeline walks", () => {
  /**
   * `CodegraphFileExtractor` materializes before it calls a walker, and
   * `materializeTree` rebuilds the field map from `fieldNameForChild`, which
   * reports ONE field name per child. tree-sitter-swift registers every type
   * position under `name` as WELL as under `type` / `return_type`, so those two
   * fields exist on a native node and vanish on a materialized one. A walker
   * that asks for them by name therefore reads every annotation in its unit
   * tests and none of them in production — silently, since the extraction is
   * still well-formed, just empty.
   *
   * These cases are the only place that difference is observable, so they are
   * the guard for reading a type POSITIONALLY (the child after `:` / `->`).
   */
  const src = [
    "import Foundation",
    "protocol Renderer {",
    "  func render() -> Widget",
    "}",
    "final class Ledger {",
    "  let repo: Repository",
    "  var items: [Entry] = []",
    "  var cache = Cache()",
    "  func post(_ id: String, entry: Entry?) -> Invoice? {",
    "    guard let invoice = self.repo.load() else { return nil }",
    "    invoice.settle()",
    "    for item in items { item.apply() }",
    "    let widget = render()",
    "    widget.draw()",
    "    return invoice",
    "  }",
    "  func render() -> Widget { Widget() }",
    "}",
    "",
  ].join("\n");

  it("extracts byte-identically from a materialized tree", () => {
    expect(extractMaterialized(src)).toEqual(extract(src));
  });

  it("still reads parameter, property and return annotations once materialized", () => {
    const r = extractMaterialized(src);
    expect(r.chunks[0].localBindings?.id?.[0].type).toBe("String");
    expect(r.chunks[0].localBindings?.entry?.[0].type).toBe("Entry");
    expect(r.chunks[0].localBindings?.item?.[0].type).toBe("Entry");
    expect(r.chunks[0].localBindings?.widget?.[0].type).toBe("Widget");
    expect(r.classFieldTypes?.Ledger?.repo).toBe("Repository");
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

/**
 * `classExtends` — the single base `super` dispatches on.
 *
 * Two grammar facts shape every case here, and neither is guessable from the
 * node type. tree-sitter-swift spells `class`, `struct`, `enum` and `actor` all
 * as `class_declaration`, so the KEYWORD is the only thing separating a type
 * that can have a superclass from three that cannot. And an inheritance clause
 * lists a superclass and protocols identically as `inheritance_specifier`,
 * marking neither — Swift's rule that the superclass comes FIRST is what makes
 * the first entry readable as a base at all.
 *
 * So the channel is deliberately narrow: a `class` only, its first specifier
 * only. A `struct` conforming to protocols records nothing, because recording
 * `Codable` as its "superclass" would let a future reader walk a hierarchy the
 * language does not have.
 *
 * Every assertion runs on the MATERIALIZED tree. That is not incidental: the
 * Swift vertical has already shipped one channel that worked natively and
 * evaluated to nothing in production, because `materializeTree` keeps one field
 * name per child and this grammar assigns two. A test that parses natively
 * cannot see that failure.
 */
describe("swift walker — classExtends", () => {
  it("records the superclass of a class", () => {
    const extraction = extractMaterialized("class Derived: Base {\n  func run() {}\n}\n");
    expect(extraction.classExtends).toEqual({ Derived: "Base" });
  });

  it("takes the FIRST specifier, which is where Swift requires the superclass", () => {
    const extraction = extractMaterialized("class Derived: Base, Equatable, Codable {\n  func run() {}\n}\n");
    expect(extraction.classExtends).toEqual({ Derived: "Base" });
  });

  it("reads through modifiers to the keyword", () => {
    const extraction = extractMaterialized("public final class Derived: Base {\n  func run() {}\n}\n");
    expect(extraction.classExtends).toEqual({ Derived: "Base" });
  });

  it("records nothing for a struct, which has no superclass to dispatch on", () => {
    const extraction = extractMaterialized("struct Point: Equatable {\n  func run() {}\n}\n");
    expect(extraction.classExtends?.Point).toBeUndefined();
  });

  it("records nothing for an enum, whose specifier is a raw type", () => {
    // `enum Status: Int` names a RAW VALUE type, not a base — reading it as one
    // would send `super` into `Int`.
    const extraction = extractMaterialized("enum Status: Int {\n  case ok\n}\n");
    expect(extraction.classExtends?.Status).toBeUndefined();
  });

  it("records nothing for an actor, which Swift forbids from inheriting", () => {
    const extraction = extractMaterialized("actor Worker: Sendable {\n  func run() {}\n}\n");
    expect(extraction.classExtends?.Worker).toBeUndefined();
  });

  it("records nothing for a class with no inheritance clause", () => {
    const extraction = extractMaterialized("class Plain {\n  func run() {}\n}\n");
    expect(extraction.classExtends?.Plain).toBeUndefined();
  });

  it("records each class of a file that declares several", () => {
    const src = ["class A: Root {", "  func a() {}", "}", "class B: A {", "  func b() {}", "}", ""].join("\n");
    expect(extractMaterialized(src).classExtends).toEqual({ A: "Root", B: "A" });
  });
});

/**
 * EXISTENTIAL annotations — `any Protocol`, and the `(any Protocol)?` spelling
 * an optional one requires.
 *
 * Swift 5.7 made `any` mandatory for an existential, so protocol-typed storage
 * in modern code is written this way and almost never as a bare protocol name:
 * Alamofire alone spells 200+ of its annotations `any P` or `(any P)?`. The
 * grammar wraps the type twice for the optional form — `optional_type` over a
 * `tuple_type` holding one `tuple_type_item` — because `(…)` is parsed as a
 * one-element tuple, which Swift's own type system does not have: a
 * parenthesized type IS the type it parenthesises.
 *
 * Both assertions run on the MATERIALIZED tree, and `tuple_type_item.type` is
 * one of the fields this grammar loses there, so the unwrap is positional like
 * every other type read here.
 */
describe("swift walker — existential and parenthesized annotations", () => {
  it("records a stored property annotated with a bare existential", () => {
    const src = ["class Session {", "  let monitor: any EventMonitor", "}", ""].join("\n");
    expect(extractMaterialized(src).classFieldTypes?.Session?.monitor).toBe("EventMonitor");
  });

  it("records a stored property annotated with a PARENTHESIZED optional existential", () => {
    const src = ["class Session {", "  weak var provider: (any StateProvider)?", "}", ""].join("\n");
    expect(extractMaterialized(src).classFieldTypes?.Session?.provider).toBe("StateProvider");
  });

  it("records a parenthesized NON-existential annotation identically", () => {
    // `(Thing)` is `Thing`; the parentheses carry no type of their own.
    const src = ["class Session {", "  let thing: (Thing)", "}", ""].join("\n");
    expect(extractMaterialized(src).classFieldTypes?.Session?.thing).toBe("Thing");
  });

  it("types a PARAMETER annotated with an existential", () => {
    const src = ["func go(monitor: any EventMonitor) {", "  monitor.request()", "}", ""].join("\n");
    const bindings = extractMaterialized(src).chunks[0].localBindings;
    expect(resolveLocalBindingType(bindings, "monitor", 2)).toBe("EventMonitor");
  });

  it("records NOTHING for a real tuple, which is not a type any member dispatches on", () => {
    const src = ["class Session {", "  let pair: (Thing, Other)", "}", ""].join("\n");
    expect(extractMaterialized(src).classFieldTypes?.Session).toBeUndefined();
  });
});

describe("swift walker — declared return types published run-global (bd tea-rags-mcp-kkwg3)", () => {
  /** Kernel chunks over the MATERIALIZED tree — the return type is read positionally, so this is the shape that matters. */
  function publishedReturns(src: string) {
    const tree = { rootNode: materializeTree(parse(src).rootNode, src) };
    const chunks = collectSymbols(tree, (node) => swiftNameOf(node), ".", true, new DefaultSymbolIdComposer());
    return extractFromSwiftFile({ tree, code: src, relPath: "Sources/Sample.swift", language: "swift", chunks })
      .structuredReturnTypes;
  }

  it("keys each declared return by the callee's OWN composed symbolId", () => {
    const src = [
      "struct Store {",
      "  func load() -> Repo { Repo() }",
      "  static func make() -> Store { Store() }",
      "  struct Inner {",
      "    func child() -> Leaf? { nil }",
      "  }",
      "}",
      "func build() -> Widget { Widget() }",
      "",
    ].join("\n");
    expect(publishedReturns(src)).toEqual({
      "Store#load": { form: "instance", name: "Repo" },
      "Store.make": { form: "instance", name: "Store" },
      // An optional return is the wrapped type: a call on it dispatches there.
      "Store.Inner#child": { form: "instance", name: "Leaf" },
      build: { form: "instance", name: "Widget" },
    });
  });

  it("keys each OVERLOAD separately, so two returns never collapse into one", () => {
    const src = [
      "struct Store {",
      "  func load(id: Int) -> Repo { Repo() }",
      "  func load(name: String) -> Cache { Cache() }",
      "}",
      "",
    ].join("\n");
    expect(publishedReturns(src)).toEqual({
      "Store#load": { form: "instance", name: "Repo" },
      "Store#load~2": { form: "instance", name: "Cache" },
    });
  });

  it("publishes nothing for a return no member can dispatch on", () => {
    const src = [
      "struct Store {",
      "  func a() -> Void {}",
      "  func b() -> Self { self }",
      "  func c<T>() -> T { fatalError() }",
      "  func d() -> [Repo] { [] }",
      "  func e() {}",
      "}",
      "",
    ].join("\n");
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.14): `d` returns an Array, which
    // a member call on its result dispatches on; it used to publish nothing.
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.18): `b` publishes the `Self`
    // MARKER, which the resolver substitutes with the receiver's type; it used
    // to publish nothing.
    expect(publishedReturns(src)).toEqual({
      "Store#b": { form: "instance", name: "Self" },
      "Store#d": { form: "instance", name: "Array" },
    });
  });
});

describe("swift walker — a type chunk's own calls run with the type as `self` (bd tea-rags-mcp-3ievc)", () => {
  /** The chunk set the pipeline hands the walker: kernel `collectSymbols` over the MATERIALIZED tree. */
  function extractWithKernelChunks(src: string) {
    const tree = { rootNode: materializeTree(parse(src).rootNode, src) };
    const chunks = collectSymbols(tree, (node) => swiftNameOf(node), ".", true, new DefaultSymbolIdComposer());
    return extractFromSwiftFile({ tree, code: src, relPath: "Sources/Sample.swift", language: "swift", chunks });
  }

  const src = [
    "struct Invoice {",
    "  var total: Int { compute() }",
    "  func compute() -> Int { return 1 }",
    "  struct Line {",
    "    let tag = Invoice.label()",
    "  }",
    "}",
    "extension Invoice {",
    "  var doubled: Int { compute() * 2 }",
    "}",
    "",
  ].join("\n");

  it("gives a type chunk a bodyScope naming the type itself, and keeps its declaration scope", () => {
    const { chunks } = extractWithKernelChunks(src);
    const invoice = chunks.find((c) => c.symbolId === "Invoice");
    expect(invoice?.scope).toEqual([]);
    expect(invoice?.bodyScope).toEqual(["Invoice"]);
    // The computed property is not chunked, so its call lands on the type chunk.
    expect(invoice?.calls.map((c) => c.member)).toEqual(["compute"]);
  });

  it("gives a NESTED type the full lexical chain, and an extension the extended type", () => {
    const { chunks } = extractWithKernelChunks(src);
    expect(chunks.find((c) => c.symbolId === "Invoice.Line")?.bodyScope).toEqual(["Invoice", "Line"]);
    expect(chunks.find((c) => c.symbolId === "Invoice~2")?.bodyScope).toEqual(["Invoice"]);
  });

  it("leaves a method chunk without a bodyScope — its scope already is the caller scope", () => {
    const method = extractWithKernelChunks(src).chunks.find((c) => c.symbolId === "Invoice#compute");
    expect(method?.scope).toEqual(["Invoice"]);
    expect(method).not.toHaveProperty("bodyScope");
  });
});

/**
 * `typeDeclarations` — which file DECLARES a type and which only re-opens it
 * (bd tea-rags-mcp-y99pg.1). tree-sitter-swift parses `extension T` as the same
 * `class_declaration` node `class T` is, and both compose the id `T`, so the
 * keyword is the only evidence of which one a node is.
 */
describe("swift walker — typeDeclarations", () => {
  it("records a type's own declaration and its conformances", () => {
    const extraction = extractMaterialized("final class Session: NSObject, Sendable {\n  func run() {}\n}\n");
    expect(extraction.typeDeclarations).toEqual([
      { typeId: "Session", reopens: false, conforms: ["NSObject", "Sendable"] },
    ]);
  });

  it("marks an extension as a re-opening and keeps the conformances it adds", () => {
    const extraction = extractMaterialized("extension SecTrust: AlamofireExtended {}\n");
    expect(extraction.typeDeclarations).toEqual([
      { typeId: "SecTrust", reopens: true, conforms: ["AlamofireExtended"] },
    ]);
  });

  it("composes a nested declaration under every enclosing type, an extension's included", () => {
    const src = [
      "struct Request {",
      "  enum State { case idle }",
      "}",
      "extension Encoder {",
      "  final class Container {}",
      "}",
      "",
    ].join("\n");
    expect(extractMaterialized(src).typeDeclarations).toEqual([
      { typeId: "Request", reopens: false },
      { typeId: "Request.State", reopens: false },
      { typeId: "Encoder", reopens: true },
      { typeId: "Encoder.Container", reopens: false },
    ]);
  });

  it("reads an extension of a nested type by its written path and drops generic arguments", () => {
    const src = [
      "extension Outer.Inner {}",
      "extension Array where Element == Header {}",
      "class Box<T>: Base<T> {}",
      "",
    ].join("\n");
    expect(extractMaterialized(src).typeDeclarations).toEqual([
      { typeId: "Outer.Inner", reopens: true },
      // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.34): a re-opening now publishes its `where` clause.
      {
        typeId: "Array",
        reopens: true,
        whereClause: { startLine: 2, endLine: 2, sameType: { Element: "Header" } },
      },
      // `genericParameters` since bd tea-rags-mcp-y99pg.13 — the type id itself still drops them.
      { typeId: "Box", reopens: false, conforms: ["Base"], genericParameters: ["T"] },
    ]);
  });

  it("records a protocol as a declaration of its own", () => {
    expect(extractMaterialized("protocol Monitor: AnyObject {\n  func tick()\n}\n").typeDeclarations).toEqual([
      { typeId: "Monitor", reopens: false, conforms: ["AnyObject"] },
    ]);
  });

  it("publishes nothing for a file that declares no type", () => {
    expect(extractMaterialized("func free() {}\n").typeDeclarations).toBeUndefined();
  });
});

/**
 * A closure's parameters take their types from the parameter the closure is
 * passed to (bd tea-rags-mcp-y99pg.3): `performEvent { $0.urlSession(...) }`
 * types `$0` from `func performEvent(_ event: @escaping (any EventMonitor) ->
 * Void)`, and `xs.forEach { $0.touch() }` from the element of an `[Thing]`.
 */
describe("swift walker — closure parameters typed by the parameter they are passed to", () => {
  const monitorSrc = [
    "final class Composite {",
    "  func performEvent(_ event: @Sendable @escaping (any Monitor) -> Void) {}",
    "  func go() {",
    "    performEvent { $0.tick() }",
    "    performEvent { m in",
    "      m.tick()",
    "    }",
    "    $0.gone()",
    "  }",
    "}",
    "",
  ].join("\n");

  it("types `$0` of a trailing closure from the callee's function-typed parameter", () => {
    expect(typeAt(monitorSrc, "$0", 4)).toBe("Monitor");
  });

  it("types a named closure parameter the same way", () => {
    expect(typeAt(monitorSrc, "m", 6)).toBe("Monitor");
  });

  it("scopes a closure parameter to the closure body", () => {
    expect(typeAt(monitorSrc, "$0", 8)).toBeUndefined();
  });

  it("reads the same facts off the materialized tree", () => {
    const bindings = extractMaterialized(monitorSrc).chunks[0].localBindings;
    expect(bindings?.$0?.[0].type).toBe("Monitor");
    expect(bindings?.m?.[0].type).toBe("Monitor");
  });

  it("types a closure passed to a top-level function as its last argument", () => {
    const src = [
      "func visit(_ n: Int, _ body: (Thing, Int) -> Void) {}",
      "func go() {",
      "  visit(3, { $0.touch() })",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "$0", 3)).toBe("Thing");
    expect(typeAt(src, "$1", 3)).toBe("Int");
  });

  it("types the closure of a sequence method from the receiver's element", () => {
    const src = [
      "func go(xs: [Thing]) {",
      "  xs.forEach { $0.touch() }",
      "  _ = xs.map { t in t.touch() }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "$0", 2)).toBe("Thing");
    expect(typeAt(src, "t", 3)).toBe("Thing");
  });

  // Session.withAllRequests { requests in requests.forEach { $0.cancel() } }
  // on `(Set<Request>) -> Void` (bd tea-rags-mcp-y99pg.32).
  it("reads the element of a sequence spelled with its generic argument — `Set<T>`, `Array<T>`", () => {
    const src = [
      "final class Pool {",
      "  func withAll(perform action: @escaping (Set<Thing>) -> Void) {}",
      "  func go(xs: Array<Thing>) {",
      "    withAll { all in",
      "      all.forEach { $0.touch() }",
      "    }",
      "    for x in xs { x.touch() }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "all", 5)).toBe("Set");
    expect(typeAt(src, "$0", 5)).toBe("Thing");
    expect(typeAt(src, "x", 7)).toBe("Thing");
    const bindings = extractMaterialized(src).chunks[0].localBindings;
    expect(bindings?.$0?.[0].type).toBe("Thing");
  });

  it("reads no element off a generic type that is not a single-element sequence", () => {
    const src = [
      "func go(r: Result<Thing, Error>, d: Dictionary<String, Thing>) {",
      "  for x in d { x.touch() }",
      "  r.map { $0.touch() }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "x", 2)).toBeUndefined();
    expect(typeAt(src, "$0", 3)).toBeUndefined();
  });

  it("declines a callee with more than one function-typed parameter", () => {
    const src = [
      "func run(_ a: (Thing) -> Void, _ b: (Other) -> Void) {}",
      "func go() {",
      "  run({ _ in }) { $0.touch() }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "$0", 3)).toBeUndefined();
  });

  it("binds no `$0` in a closure that nests an implicit-parameter closure it cannot type", () => {
    const src = [
      "func each(_ body: (Thing) -> Void) {}",
      "func go() {",
      "  each {",
      "    unknown { $0.other() }",
      "    $0.touch()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "$0", 4)).toBeUndefined();
  });

  it("types no closure passed to a callee this file does not declare", () => {
    const src = ["func go() {", "  unknown { $0.touch() }", "}", ""].join("\n");
    expect(typeAt(src, "$0", 2)).toBeUndefined();
  });
});

/**
 * A generic parameter is not a type the index can hold: `responseSerializer:
 * Serializer` where `<Serializer: DataResponseSerializerProtocol>` dispatches on
 * the protocol, and `func request<R: Request>(for: …, as type: R.Type) -> R?`
 * returns whatever type the `as:` argument names (bd tea-rags-mcp-y99pg.6).
 */
describe("swift walker — generic parameters read through their constraints", () => {
  it("types a parameter declared with a constrained generic parameter as the constraint", () => {
    const src = [
      "func go<Serializer: ResponseSerializer>(serializer: Serializer) {",
      "  serializer.serialize()",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "serializer", 2)).toBe("ResponseSerializer");
  });

  it("reads a `where` clause constraint on the enclosing type for a stored property", () => {
    const src = [
      "final class Interceptor<AuthenticatorType>: Base where AuthenticatorType: Authenticator {",
      "  let authenticator: AuthenticatorType",
      "}",
      "",
    ].join("\n");
    expect(extract(src).classFieldTypes?.Interceptor?.authenticator).toBe("Authenticator");
  });

  it("binds nothing for an unconstrained generic parameter", () => {
    const src = ["func go<T>(value: T) {", "  value.use()", "}", ""].join("\n");
    expect(typeAt(src, "value", 2)).toBeUndefined();
  });

  it("types an opaque `some P` parameter as the protocol", () => {
    const src = ["func go(value: some Encoder) {", "  value.use()", "}", ""].join("\n");
    expect(typeAt(src, "value", 2)).toBe("Encoder");
  });

  it("types a call-result local from the metatype argument a generic return is bound by", () => {
    const src = [
      "final class Delegate {",
      "  func request<R: Request>(for task: Int, as type: R.Type) -> R? { nil }",
      "  func go() {",
      "    if let request = request(for: 1, as: DataRequest.self) {",
      "      request.didReceive()",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "request", 5)).toBe("DataRequest");
  });

  it("falls back to the constraint when the metatype argument is not a `.self` literal", () => {
    const src = [
      "final class Delegate {",
      "  func request<R: Request>(for task: Int, as type: R.Type) -> R? { nil }",
      "  func go(kind: Request.Type) {",
      "    guard let request = request(for: 1, as: kind) else { return }",
      "    request.didReceive()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "request", 5)).toBe("Request");
  });
});

/**
 * A local whose right-hand side is a value chain this file cannot type — its
 * links live in other files — is recorded by SPELLING in `callResultBindings`
 * for the resolver to fold with the whole symbol table in scope (bd
 * tea-rags-mcp-y99pg.6). A cast types its local outright.
 */
describe("swift walker — locals typed later: value-chain spellings and casts", () => {
  it("records an untyped chain local by its spelling, sugar and arguments stripped", () => {
    const src = ["func go() {", "  let e = try sp?.mgr?.eval(forHost: h)", "  e.run()", "}", ""].join("\n");
    const chunk = extract(src).chunks[0];
    expect(chunk.callResultBindings?.e).toEqual([{ line: 2, callee: "sp.mgr.eval" }]);
    expect(chunk.localBindings?.e).toBeUndefined();
  });

  it("records the left operand of `??`, scoped to an `if let` body", () => {
    const src = [
      "func go() {",
      "  if let r = sp?.req(for: t)?.handler ?? sp?.handler {",
      "    r.run()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).chunks[0].callResultBindings?.r).toEqual([
      { line: 2, callee: "sp.req.handler", scopeEndLine: 4 },
    ]);
  });

  // Request.cURLDescription: `let cookies = cookieStorage.cookies(for: url)` two
  // lines below `if`, folding a `cookieStorage` bound one clause above it (bd
  // tea-rags-mcp-y99pg.32). A spelling is visible strictly below its line, so
  // every clause sitting on the `if` line hid each from the next.
  it("positions each clause of a multi-line condition on its own line", () => {
    const src = [
      "func go() {",
      "  if",
      "    let storage = configuration.httpCookieStorage,",
      "    let cookies = storage.cookies(for: url), !cookies.isEmpty {",
      "    cookies.run()",
      "  }",
      "  guard let a = sp.a, let b = a.b else { return }",
      "}",
      "",
    ].join("\n");
    const bindings = extractMaterialized(src).chunks[0].callResultBindings ?? {};
    expect(bindings.storage).toEqual([{ line: 3, callee: "configuration.httpCookieStorage", scopeEndLine: 6 }]);
    expect(bindings.cookies).toEqual([{ line: 4, callee: "storage.cookies", scopeEndLine: 6 }]);
    expect(bindings.a?.[0].line).toBe(7);
    expect(bindings.b?.[0].line).toBe(7);
  });

  it("types a cast local by the cast's target type", () => {
    const src = ["func go() {", "  let c = x as? Foo", "  c?.run()", "}", ""].join("\n");
    expect(typeAt(src, "c", 3)).toBe("Foo");
  });

  it("records no spelling for a chain headed by a bare call", () => {
    const src = ["func go() {", "  let n = make().value", "  n.run()", "}", ""].join("\n");
    expect(extract(src).chunks[0].callResultBindings).toBeUndefined();
  });

  it("reads the same spelling off the materialized tree", () => {
    const src = ["func go() {", "  let e = try sp?.mgr?.eval(forHost: h)", "  e.run()", "}", ""].join("\n");
    expect(extractMaterialized(src).chunks[0].callResultBindings?.e?.[0].callee).toBe("sp.mgr.eval");
  });
});

describe("swift walker — a local declared in a closure ends with the closure", () => {
  it("keeps a closure's local out of the lines after its closing brace", () => {
    const src = [
      "func go() {",
      "  run {",
      "    let helper = Helper()",
      "    helper.use()",
      "  }",
      "  helper.gone()",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "helper", 4)).toBe("Helper");
    expect(typeAt(src, "helper", 6)).toBeUndefined();
  });
});

/**
 * Invoking a closure VALUE is not a call to a declared symbol (bd
 * tea-rags-mcp-y99pg.8): `stream(event)` on a `stream:` parameter,
 * `perform()` on a local closure, `requestDidFinish?(request)` on an optional
 * closure property. Emitting them hands the terminal short-name pass a name
 * whose namesake function is never the target.
 */
describe("swift walker — invocations of closure values are not calls", () => {
  const callees = (src: string): string[] => extract(src).chunks[0].calls.map((c) => c.member);

  it("emits no call for a parameter invoked as a function", () => {
    expect(callees("func go(stream: (Int) -> Void) {\n  stream(2)\n  helper()\n}\n")).toEqual(["helper"]);
  });

  it("emits no call for an optional call", () => {
    expect(callees("func go() {\n  requestDidFinish?(1)\n}\n")).toEqual([]);
  });

  it("emits no call for a local closure or a closure parameter", () => {
    const src = [
      "func go() {",
      "  let perform = { 1 }",
      "  perform()",
      "  run { handler in",
      "    handler()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(callees(src)).toEqual(["run"]);
  });

  it("keeps a call whose name is only declared AFTER it, or in another function", () => {
    const src = [
      "func other(helper: () -> Void) {}",
      "func go() {",
      "  helper()",
      "  let helper = { 1 }",
      "}",
      "",
    ].join("\n");
    expect(callees(src)).toEqual(["helper"]);
  });
});

describe("swift walker — protocol property requirements publish their types", () => {
  it("types a `var x: T { get }` requirement like a stored property", () => {
    const src = [
      "protocol StateProvider {",
      "  var serverTrustManager: ServerTrustManager? { get }",
      "  var monitor: (any EventMonitor)? { get set }",
      "}",
      "",
    ].join("\n");
    expect(extract(src).classFieldTypes?.StateProvider).toEqual({
      serverTrustManager: "ServerTrustManager",
      monitor: "EventMonitor",
    });
  });

  it("reads the same requirement off the materialized tree", () => {
    const src = ["protocol StateProvider {", "  var manager: Manager { get }", "}", ""].join("\n");
    expect(extractMaterialized(src).classFieldTypes?.StateProvider?.manager).toBe("Manager");
  });
});

describe("swift walker — an array's element accessors return the element", () => {
  it("types a local bound to `removeFirst()` / `first` of an `[T]`", () => {
    const src = [
      "func go(adapters: [any RequestAdapter]) {",
      "  var pending = adapters",
      "  let adapter = pending.removeFirst()",
      "  adapter.adapt()",
      "  if let head = adapters.first {",
      "    head.adapt()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "adapter", 4)).toBe("RequestAdapter");
    expect(typeAt(src, "head", 6)).toBe("RequestAdapter");
    // INVARIANT CHANGED (bd tea-rags-mcp-y99pg.14): the array itself is an Array.
    expect(typeAt(src, "pending", 4)).toBe("Array");
  });
});

describe("swift walker — generic constructions and the implicit `catch` binding", () => {
  it("types a generic construction `Protected<[T]>(…)` as its nominal, and records it as a call", () => {
    const src = [
      "final class Request {",
      "  let validators = Protected<[() -> Void]>([])",
      "  func go() {",
      "    let local = Box<Int>(1)",
      "    local.open()",
      "  }",
      "}",
      "",
    ].join("\n");
    const r = extract(src);
    expect(r.classFieldTypes?.Request?.validators).toBe("Protected");
    expect(typeAt(src, "local", 5)).toBe("Box");
    expect(r.chunks[0].calls.map((c) => c.member)).toEqual(expect.arrayContaining(["Protected", "Box"]));
  });

  it("binds `error` as `Error` inside a `catch` block without a pattern, and only there", () => {
    const src = [
      "func go() {",
      "  do {",
      "    try run()",
      "  } catch {",
      "    error.report()",
      "  }",
      "  error.gone()",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "error", 5)).toBe("Error");
    expect(typeAt(src, "error", 7)).toBeUndefined();
  });
});

/**
 * Argument labels on both sides (bd tea-rags-mcp-y99pg.7): a declaration
 * publishes its labelled parameters as `kwargs`, its unlabelled ones as
 * `arity` and whether it takes a closure as `acceptsBlock`; a call publishes
 * the labels it writes, its unlabelled argument count and whether it passes a
 * trailing closure.
 */
describe("swift walker — argument-label signatures", () => {
  it("publishes a declaration's labels, positional arity and closure acceptance on its chunk", () => {
    const src = [
      "func validate(statusCode: Int, _ x: Int = 0, _ rest: Int..., completion: @escaping () -> Void) {}",
      "",
    ].join("\n");
    const chunk = extract(src, [{ symbolId: "validate", scope: [], startLine: 1, endLine: 1 }]).chunks[0];
    expect(chunk.kwargs).toEqual({ required: ["statusCode"], optional: ["completion"], hasSplat: false });
    expect(chunk.arity).toEqual({ minRequired: 0, maxPositional: 2, hasSplat: true });
    expect(chunk.acceptsBlock).toBe(true);
  });

  it("publishes an initializer's signature, and a closure-free one as not accepting a block", () => {
    const src = ["struct Box {", "  init(url: URL, _ n: Int) {}", "}", ""].join("\n");
    const chunks = [
      { symbolId: "Box", scope: [], startLine: 1, endLine: 3 },
      { symbolId: "Box#init", scope: ["Box"], startLine: 2, endLine: 2 },
    ];
    const chunk = extract(src, chunks).chunks[1];
    expect(chunk.kwargs).toEqual({ required: ["url"], optional: [], hasSplat: false });
    expect(chunk.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
    expect(chunk.acceptsBlock).toBe(false);
  });

  it("records a call's labels, unlabelled count and trailing closure", () => {
    const src = ["func go() {", "  validate(statusCode: 1) { }", "  run(1, x: 2)", "}", ""].join("\n");
    const { calls } = extract(src).chunks[0];
    expect(calls.find((c) => c.member === "validate")).toMatchObject({
      argCount: 0,
      kwargKeys: ["statusCode"],
      passesBlock: true,
    });
    expect(calls.find((c) => c.member === "run")).toMatchObject({ argCount: 1, kwargKeys: ["x"], passesBlock: false });
  });
});

describe("swift walker — a closure spelled through a typealias", () => {
  it("counts an `@escaping` alias as a closure and an unmarked alias as a possible one", () => {
    const src = [
      "func progress(queue: DispatchQueue = .main, closure: @escaping ProgressHandler) {}",
      "func configure(_ closure: QuickConfigurer) {}",
      "func count(of items: [Item]) {}",
      "",
    ].join("\n");
    const chunks = [
      { symbolId: "progress", scope: [], startLine: 1, endLine: 1 },
      { symbolId: "configure", scope: [], startLine: 2, endLine: 2 },
      { symbolId: "count", scope: [], startLine: 3, endLine: 3 },
    ];
    const [progress, configure, count] = extract(src, chunks).chunks;
    expect(progress.kwargs).toEqual({ required: [], optional: ["queue", "closure"], hasSplat: false });
    expect(progress.acceptsBlock).toBe(true);
    expect(configure.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
    expect(configure.acceptsBlock).toBe(true);
    expect(count.acceptsBlock).toBe(false);
  });
});

describe("swift walker — parameter modifiers and metatypes (bd tea-rags-mcp-y99pg.12)", () => {
  it("types an inout parameter by the type after its modifier", () => {
    const src = ["func handle(insideLock state: inout MutableState) {", "  state.update()", "}", ""].join("\n");
    expect(typeAt(src, "state", 2)).toBe("MutableState");
    expect(resolveLocalBindingType(extractMaterialized(src).chunks[0].localBindings, "state", 2)).toBe("MutableState");
  });

  it("types a metatype parameter by the type it is the metatype of", () => {
    const src = ["func make(_ type: EmptyResponse.Type, of kind: Kind.Type?) {", "  type.emptyValue()", "}", ""].join(
      "\n",
    );
    expect(typeAt(src, "type", 2)).toBe("EmptyResponse");
    expect(typeAt(src, "kind", 2)).toBe("Kind");
  });
});

describe("swift walker — generic closure parameters across files (bd tea-rags-mcp-y99pg.13)", () => {
  it("publishes a generic type's parameters, closure signatures and generic field arguments", () => {
    const src = [
      "final class Protected<Value> {",
      "  func read<U>(_ closure: (Value) throws -> U) rethrows -> U { fatalError() }",
      "  func write<U>(_ closure: (inout Value) throws -> U) rethrows -> U { fatalError() }",
      "  func withState(perform: (Request.State) -> Void) {}",
      "}",
      "final class Request {",
      "  let mutableState: Protected<MutableState>",
      "}",
      "",
    ].join("\n");
    const facts = extract(src).typeDeclarations ?? [];
    const protectedFact = facts.find((f) => f.typeId === "Protected");
    expect(protectedFact?.genericParameters).toEqual(["Value"]);
    expect(protectedFact?.memberClosureParameters).toEqual({
      read: ["Value"],
      write: ["Value"],
      withState: ["Request.State"],
    });
    expect(facts.find((f) => f.typeId === "Request")?.fieldTypeArguments).toEqual({
      mutableState: ["MutableState"],
    });
  });

  // `adapter.adapt(…) { result in let r = try result.get() }` in another file
  // needs `Result`'s arguments to type `get()` (bd tea-rags-mcp-y99pg.32).
  it("publishes a closure parameter's concrete generic arguments with its nominal", () => {
    const src = [
      "public protocol RequestAdapter {",
      "  func adapt(_ urlRequest: URLRequest, using state: State,",
      "             completion: @escaping @Sendable (_ result: Result<URLRequest, any Error>) -> Void)",
      "}",
      "final class Box<Value> {",
      "  func load(_ done: (Result<Value, Error>) -> Void) {}",
      "  func each(_ body: (Set<Thing>) -> Void) {}",
      "}",
      "",
    ].join("\n");
    for (const facts of [extract(src).typeDeclarations ?? [], extractMaterialized(src).typeDeclarations ?? []]) {
      expect(facts.find((f) => f.typeId === "RequestAdapter")?.memberClosureParameters).toEqual({
        adapt: ["Result<URLRequest, Error>"],
      });
      // An argument naming a generic parameter is bound per use, not declared.
      expect(facts.find((f) => f.typeId === "Box")?.memberClosureParameters).toEqual({
        load: ["Result"],
        each: ["Set<Thing>"],
      });
    }
  });

  it("binds a closure's parameters to the callee they are passed to when no declaration here types them", () => {
    const src = [
      "final class Request {",
      "  func run() {",
      "    mutableState.write { mutableState in",
      "      mutableState.state.canTransitionTo(.resumed)",
      "    }",
      "    mutableState.write { $0.updateCredential(1) }",
      "  }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].callResultBindings ?? {};
    expect(bindings.mutableState).toEqual([
      { line: 3, callee: "mutableState.write", closureParameter: 0, scopeEndLine: 5 },
    ]);
    expect(bindings.$0).toEqual([{ line: 6, callee: "mutableState.write", closureParameter: 0, scopeEndLine: 6 }]);
  });

  it("binds a closure passed to a BARE callee no declaration here types (bd tea-rags-mcp-y99pg.29)", () => {
    const src = [
      "final class DataRequest {",
      "  func run() async {",
      "    await withCheckedContinuation { continuation in",
      "      continuation.resume(returning: 1)",
      "    }",
      "    compactMap { $0.event }",
      "  }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].callResultBindings ?? {};
    expect(bindings.continuation).toEqual([
      { line: 3, callee: "withCheckedContinuation", closureParameter: 0, scopeEndLine: 5 },
    ]);
    expect(bindings.$0).toEqual([{ line: 6, callee: "compactMap", closureParameter: 0, scopeEndLine: 6 }]);
  });

  it("binds a closure passed to a CONSTRUCTION by the constructed type (bd tea-rags-mcp-y99pg.29)", () => {
    const src = [
      "final class Request {",
      "  func run() {",
      "    StreamOf<T>(bufferingPolicy: p) { continuation in",
      "      continuation.finish()",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].callResultBindings ?? {};
    expect(bindings.continuation).toEqual([{ line: 3, callee: "StreamOf", closureParameter: 0, scopeEndLine: 5 }]);
  });

  it("publishes an initializer's closure parameters, skipping a closure slot that takes none", () => {
    const src = [
      "public struct StreamOf<Element> {",
      "  fileprivate typealias Continuation = AsyncStream<Element>.Continuation",
      "  fileprivate init(bufferingPolicy: BufferingPolicy = .unbounded,",
      "                   onTermination: (() -> Void)? = nil,",
      "                   builder: @escaping (Continuation) -> Void) {}",
      "}",
      "",
    ].join("\n");
    const fact = (extract(src).typeDeclarations ?? []).find((f) => f.typeId === "StreamOf");
    expect(fact?.memberClosureParameters).toEqual({ init: ["Continuation"] });
  });

  it("binds only the LAST closure of a call, the one a closure-typed parameter lookup describes", () => {
    const src = [
      "final class Task {",
      "  func run() {",
      "    handle { first in",
      "      first.go()",
      "    } onCancel: { second in",
      "      second.stop()",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].callResultBindings ?? {};
    expect(bindings.first).toBeUndefined();
    expect(bindings.second).toEqual([{ line: 5, callee: "handle", closureParameter: 0, scopeEndLine: 7 }]);
  });

  it("binds a property observer's implicit and named parameters to the property's type (bd tea-rags-mcp-y99pg.31)", () => {
    const src = [
      "final class DetailViewController {",
      "  var request: Request? {",
      "    didSet {",
      "      oldValue?.cancel()",
      "    }",
      "    willSet { newValue?.resume() }",
      "  }",
      "  var task: Task {",
      "    didSet(previous) { previous.cancel() }",
      "  }",
      "  var untyped = make() {",
      "    didSet { oldValue.cancel() }",
      "  }",
      "}",
      "",
    ].join("\n");
    for (const out of [extract(src), extractMaterialized(src)]) {
      const bindings = out.chunks[0].localBindings;
      expect(resolveLocalBindingType(bindings, "oldValue", 4)).toBe("Request");
      expect(resolveLocalBindingType(bindings, "newValue", 6)).toBe("Request");
      expect(resolveLocalBindingType(bindings, "previous", 9)).toBe("Task");
      // Scoped to its own clause: nothing below it reads the observer's value.
      expect(resolveLocalBindingType(bindings, "oldValue", 12)).toBeUndefined();
    }
  });

  it("spells a closure's callee through a construction head, the one value chain that starts with a call (bd tea-rags-mcp-y99pg.31)", () => {
    const src = [
      "final class DataStreamRequest {",
      "  func parse() {",
      "    let result = Result { try serializer.serialize(data) }",
      "      .mapError { $0.asAFError(or: .failed) }",
      "    make(1).then { $0.run() }",
      "  }",
      "}",
      "",
    ].join("\n");
    for (const out of [extract(src), extractMaterialized(src)]) {
      const bindings = out.chunks[0].callResultBindings ?? {};
      expect(bindings.$0).toEqual([
        {
          line: 4,
          callee: "Result { try serializer.serialize(data) }.mapError",
          closureParameter: 0,
          scopeEndLine: 4,
        },
      ]);
    }
  });
});

describe("swift walker — enum case payload bindings (bd tea-rags-mcp-y99pg.16)", () => {
  it("publishes each enum case's payload types in position order", () => {
    const src = [
      "enum ExampleUnit {",
      "  case example(Example)",
      "  case group(ExampleGroup, count: Int)",
      "  case failed(any Error)",
      "  case empty",
      "}",
      "",
    ].join("\n");
    const fact = (extract(src).typeDeclarations ?? []).find((f) => f.typeId === "ExampleUnit");
    expect(fact?.enumCasePayloads).toEqual({
      example: ["Example"],
      group: ["ExampleGroup", "Int"],
      failed: ["Error"],
    });
  });

  it("binds a switch case's payload names to the subject they destructure", () => {
    const src = [
      "final class Group {",
      "  func walk() {",
      "    switch unit {",
      "    case .group(let exampleGroup, _):",
      "      exampleGroup.walkDownExamples()",
      "    case let .failed(error):",
      "      error.asAFError()",
      "    case .empty:",
      "      break",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].callResultBindings ?? {};
    expect(bindings.exampleGroup).toEqual([
      { line: 4, callee: "unit", enumPayload: { caseName: "group", index: 0 }, scopeEndLine: 5 },
    ]);
    expect(bindings.error).toEqual([
      { line: 6, callee: "unit", enumPayload: { caseName: "failed", index: 0 }, scopeEndLine: 7 },
    ]);
  });
});

describe("swift walker — collection constructions and dictionary iteration (bd tea-rags-mcp-y99pg.17)", () => {
  it("types an `[T]()` construction as an Array of T, so a for-in over it binds T", () => {
    const src = [
      "final class ExampleGroup {",
      "  private var childUnits = [ExampleUnit]()",
      "  func walk() {",
      "    for unit in childUnits {",
      "      unit.describe()",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "childUnits", 2)).toBe("Array");
    expect(typeAt(src, "unit", 5)).toBe("ExampleUnit");
  });

  it("binds a dictionary for-in's key and value names from the dictionary's declared types", () => {
    const src = [
      "final class World {",
      "  private var specs: [String: ExampleGroup] = [:]",
      "  func all() {",
      "    for (_, group) in specs {",
      "      group.walkDownExamples()",
      "    }",
      "    let named = [String: Example]()",
      "    for (name, example) in named {",
      "      example.run(name)",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "group", 5)).toBe("ExampleGroup");
    expect(typeAt(src, "named", 8)).toBe("Dictionary");
    expect(typeAt(src, "example", 9)).toBe("Example");
    expect(typeAt(src, "name", 9)).toBe("String");
  });
});

describe("swift walker — a generic-argument extension's spelled id (bd tea-rags-mcp-y99pg.19)", () => {
  it("publishes the id its members compose under beside the bare type id", () => {
    const src = ["extension Collection<String> {", '  func qualityEncoded() -> String { "" }', "}", ""].join("\n");
    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "Collection", reopens: true, spelledAs: "Collection<String>" },
    ]);
  });
});

describe("swift walker — `self` in an extension of an array type iterates its element (bd tea-rags-mcp-y99pg)", () => {
  const cases = [
    ["an array-spelled extension", "extension [Evaluator] {"],
    ["an `Array where Element ==` extension", "extension Array where Element == Evaluator {"],
  ] as const;
  for (const [label, header] of cases) {
    it(`types \`for x in self\` by the element in ${label}`, () => {
      const src = [header, "  func run() {", "    for e in self {", "      e.evaluate()", "    }", "  }", "}", ""].join(
        "\n",
      );
      expect(typeAt(src, "e", 4)).toBe("Evaluator");
      expect(resolveLocalBindingType(extractMaterialized(src).chunks[0].localBindings, "e", 4)).toBe("Evaluator");
    });
  }

  it("types nothing for `self` in an extension of a non-array type", () => {
    const src = [
      "extension Box where Element == Evaluator {",
      "  func run() {",
      "    for e in self { e.go() }",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "e", 3)).toBeUndefined();
  });
});

describe("swift walker — generic-typed fields and extension `where` clauses (bd tea-rags-mcp-y99pg.34)", () => {
  const src = [
    "final class Protected<Value> {",
    "  private var value: Value",
    "  var backup: Value?",
    "  let count: Int",
    "}",
    "extension Protected where Value == Request.MutableState {",
    "  func go() { value.state.run() }",
    "}",
    "extension Box where Item: Bundle, Other == [Cert] {",
    "}",
    "extension Plain {}",
    "",
  ].join("\n");
  const expected = [
    {
      typeId: "Protected",
      reopens: false,
      genericParameters: ["Value"],
      genericFieldParameters: { value: "Value", backup: "Value" },
      // `backup: Value?` is also an optional property (bd tea-rags-mcp-y99pg.33).
      optionalProperties: ["backup"],
    },
    {
      typeId: "Protected",
      reopens: true,
      whereClause: { startLine: 6, endLine: 8, sameType: { Value: "Request.MutableState" } },
    },
    {
      typeId: "Box",
      reopens: true,
      whereClause: { startLine: 9, endLine: 10, sameType: { Other: "[Cert]" }, bounds: { Item: "Bundle" } },
    },
    { typeId: "Plain", reopens: true },
  ];

  it("publishes which fields a generic parameter types, and each re-opening's where clause", () => {
    expect(extract(src).typeDeclarations).toEqual(expected);
  });

  it("publishes the same facts off the MATERIALIZED tree", () => {
    expect(extractMaterialized(src).typeDeclarations).toEqual(expected);
  });
});

describe("swift walker — function typealias returns (bd tea-rags-mcp-y99pg.22)", () => {
  it("publishes what a function-typed alias declared in a type returns", () => {
    const src = [
      "struct DataResponsePublisher {",
      "  private typealias Handler = (@escaping @Sendable (_ response: Int) -> Void) -> DataRequest",
      "  typealias Output = Int",
      "}",
      "",
    ].join("\n");
    const fact = (extract(src).typeDeclarations ?? []).find((f) => f.typeId === "DataResponsePublisher");
    expect(fact?.functionAliasReturns).toEqual({ Handler: "DataRequest" });
  });
});

describe("swift walker — protocol compositions (bd tea-rags-mcp-y99pg.28)", () => {
  it("types a composition of one protocol and marker protocols as that protocol", () => {
    const src = [
      "func receive<S>(subscriber: S) where S: Subscriber & Sendable {",
      "  subscriber.receive(1)",
      "}",
      "func take<T: AnyObject & Monitor>(monitor: T, both: any Monitor & Logger, any: any Sendable & Monitor) {",
      "  monitor.log()",
      "}",
      "",
    ].join("\n");
    expect(typeAt(src, "subscriber", 2)).toBe("Subscriber");
    expect(typeAt(src, "monitor", 5)).toBe("Monitor");
    expect(typeAt(src, "any", 5)).toBe("Monitor");
  });

  it("types nothing for a composition of two protocols", () => {
    const src = ["func take(both: any Monitor & Logger) {", "  both.log()", "}", ""].join("\n");
    expect(typeAt(src, "both", 2)).toBeUndefined();
  });
});

describe("swift walker — literal-initialized locals (bd tea-rags-mcp-y99pg.27)", () => {
  const src = [
    "func go() {",
    '  var components = ["$ curl -v"]',
    '  let name = "x"',
    "  let things = [Thing(), Thing()]",
    '  let mixed = [Thing(), "y"]',
    "  let empty = []",
    '  components.append("-X")',
    "  let head = things.first",
    "  let other = mixed.first",
    "}",
    "",
  ].join("\n");

  it("types a string literal as String", () => {
    expect(typeAt(src, "name", 7)).toBe("String");
  });

  it("types a non-empty array literal as Array of its elements' common type", () => {
    expect(typeAt(src, "components", 7)).toBe("Array");
    expect(typeAt(src, "things", 7)).toBe("Array");
    expect(typeAt(src, "mixed", 7)).toBe("Array");
    expect(typeAt(src, "head", 10)).toBe("Thing");
    expect(typeAt(src, "other", 10)).toBeUndefined();
  });

  it("types nothing for an empty literal", () => {
    expect(typeAt(src, "empty", 7)).toBeUndefined();
  });
});

describe("swift walker — construction-initialized field arguments (bd tea-rags-mcp-y99pg.26)", () => {
  const src = [
    "final class Protected<Value> {",
    "  init(_ value: Value) {}",
    "  init(label: String) {}",
    "}",
    "final class DataRequest {",
    "  private let dataMutableState = Protected(DataMutableState())",
    "  let validators = Protected<[@Sendable () -> Void]>([])",
    '  let named = Protected(label: "x")',
    "  let plain = Helper()",
    "}",
    "",
  ].join("\n");

  it("publishes the generic arguments an explicitly specialised construction spells", () => {
    for (const out of [extract(src), extractMaterialized(src)]) {
      const fact = out.typeDeclarations?.find((f) => f.typeId === "DataRequest");
      expect(fact?.fieldTypeArguments).toEqual({ validators: ["Array"] });
    }
  });

  it("publishes an unspecialised construction's argument labels and types", () => {
    for (const out of [extract(src), extractMaterialized(src)]) {
      const fact = out.typeDeclarations?.find((f) => f.typeId === "DataRequest");
      expect(fact?.fieldConstructions).toEqual({
        dataMutableState: { type: "Protected", arguments: [{ label: null, type: "DataMutableState" }] },
      });
    }
  });

  it("publishes which generic parameter each initializer parameter binds", () => {
    for (const out of [extract(src), extractMaterialized(src)]) {
      const fact = out.typeDeclarations?.find((f) => f.typeId === "Protected");
      expect(fact?.genericInitializers).toEqual([{ labels: [null], binds: ["Value"] }]);
    }
  });
});

describe("swift walker — a protocol extension's `where Self` constraints (bd tea-rags-mcp-y99pg.33)", () => {
  const src = [
    "extension Download where Self: DataSerializer {",
    "  func serializeDownload() {",
    "    serialize()",
    "  }",
    "}",
    "extension Download where Self == URLSerializer, Value: Equatable {",
    "}",
    "extension Protected where Value: Equatable {",
    "}",
    "",
  ].join("\n");

  it("publishes the types a `Self` constraint names, with the extension's line span", () => {
    for (const out of [extract(src), extractMaterialized(src)]) {
      // The same clause also reaches `whereClause` (bd tea-rags-mcp-y99pg.34);
      // this pins only the `Self` reading.
      const selfFacts = out.typeDeclarations?.map(({ typeId, reopens, selfConstraints }) => ({
        typeId,
        reopens,
        ...(selfConstraints ? { selfConstraints } : {}),
      }));
      expect(selfFacts).toEqual([
        { typeId: "Download", reopens: true, selfConstraints: { types: ["DataSerializer"], startLine: 1, endLine: 5 } },
        { typeId: "Download", reopens: true, selfConstraints: { types: ["URLSerializer"], startLine: 6, endLine: 7 } },
        { typeId: "Protected", reopens: true },
      ]);
    }
  });
});

describe("swift walker — property attribute types, the candidates for a property wrapper (bd tea-rags-mcp-y99pg.33)", () => {
  const src = [
    "final class Networking: ObservableObject {",
    "  @Published var result: Result<A, E>?",
    '  @Published var message = "No response."',
    "  @MainActor @Clamped(max: 3) var level: Int = 1",
    "  @objc var plain: Int = 0",
    "  var bare: Int = 0",
    "}",
    "",
  ].join("\n");

  it("publishes each stored property's UpperCamelCase attribute types in source order", () => {
    for (const out of [extract(src), extractMaterialized(src)]) {
      const fact = out.typeDeclarations?.find((f) => f.typeId === "Networking");
      expect(fact?.propertyAttributeTypes).toEqual({
        result: ["Published"],
        message: ["Published"],
        level: ["MainActor", "Clamped"],
      });
    }
  });
});

/**
 * A type's member typealias is how it satisfies an associated type of a
 * protocol it conforms to (bd tea-rags-mcp-y99pg.33): `typealias Output = …`
 * inside a `Publisher` is what every `Self.Output` Combine declares means.
 */
describe("swift walker — member type aliases (bd tea-rags-mcp-y99pg.33)", () => {
  const src = [
    "public struct DataStreamPublisher<Value>: Publisher {",
    "  public typealias Output = DataStreamRequest.Stream<Value, AFError>",
    "  public typealias Failure = Never",
    "  private typealias Handler = (@escaping Handler<Value>) -> DataStreamRequest",
    "  typealias Maybe = Int?",
    "}",
    "",
  ].join("\n");

  it("publishes each nominal alias of a type body by its nominal path", () => {
    for (const out of [extract(src), extractMaterialized(src)]) {
      const fact = out.typeDeclarations?.find((f) => f.typeId === "DataStreamPublisher");
      expect(fact?.memberTypeAliases).toEqual({ Output: "DataStreamRequest.Stream", Failure: "Never" });
    }
  });
});

/**
 * `T?` is `Optional<T>` (bd tea-rags-mcp-y99pg.33). `response.map(\.statusCode)`
 * on a `response: HTTPURLResponse?` is `Optional.map`, and only the
 * source's `?` / `!` says whether a member is read off the optional or off
 * what it wraps — so the walker keeps both facts next to the ones it
 * already published (the `type` string, the normalized receiver) instead
 * of in place of them.
 */
describe("swift walker — optional values and unwrap sugar (bd tea-rags-mcp-y99pg.33)", () => {
  it("marks a binding DECLARED `T?` as an Optional of T, and nothing else", () => {
    const src = [
      "func go(response: HTTPURLResponse?, plain: Foo, forced: Bar!) {",
      "  var local: Baz? = nil",
      "  if let response {",
      "    response.run()",
      "  }",
      "}",
      "",
    ].join("\n");
    for (const out of [extract(src), extractMaterialized(src)]) {
      const bindings = out.chunks[0].localBindings ?? {};
      expect(bindings.response?.[0]).toMatchObject({
        type: "HTTPURLResponse",
        typeRef: { form: "instance", name: "Optional", args: [{ form: "instance", name: "HTTPURLResponse" }] },
      });
      expect(bindings.local?.[0].typeRef).toEqual({
        form: "instance",
        name: "Optional",
        args: [{ form: "instance", name: "Baz" }],
      });
      // The `if let` re-binding is the unwrapped value.
      expect(bindings.response?.[1]).toMatchObject({ type: "HTTPURLResponse" });
      expect(bindings.response?.[1].typeRef).toBeUndefined();
      expect(bindings.plain?.[0].typeRef).toBeUndefined();
    }
  });

  it("publishes the properties a type declares optional", () => {
    const src = [
      "struct Completion {",
      "  let request: URLRequest?",
      "  let error: AFError?",
      "  let metrics: Metrics",
      "}",
      "",
    ].join("\n");
    for (const out of [extract(src), extractMaterialized(src)]) {
      const fact = out.typeDeclarations?.find((f) => f.typeId === "Completion");
      expect(fact?.optionalProperties).toEqual(["request", "error"]);
    }
  });

  it("keeps the receiver as written beside the normalized one when unwrap sugar was stripped", () => {
    const src = ["func go() {", "  a?.b!.c()", "  obj?.maybe()", "  plain.run()", "}", ""].join("\n");
    for (const out of [extract(src), extractMaterialized(src)]) {
      const { calls } = out.chunks[0];
      expect(calls).toContainEqual(expect.objectContaining({ receiver: "a.b", writtenReceiver: "a?.b!", member: "c" }));
      expect(calls).toContainEqual(
        expect.objectContaining({ receiver: "obj", writtenReceiver: "obj?", member: "maybe" }),
      );
      expect(calls.find((c) => c.member === "run")?.writtenReceiver).toBeUndefined();
    }
  });
});

/**
 * `let requests = mutableState.read(\.activeRequests)` then
 * `for request in requests` (Alamofire `Session`, bd tea-rags-mcp-y99pg.37):
 * the key path is the one argument a generic method's return depends on, so
 * the spelling keeps it; the loop item is recorded as an ELEMENT of the
 * spelled sequence, and the generic method says its return is its closure's.
 */
describe("swift walker — key-path arguments and for-in over a spelled sequence", () => {
  const src = [
    "final class Session {",
    "  func go() {",
    "    let requests = mutableState.read(\\.activeRequests)",
    "    for request in requests where !request.isFinished {",
    "      request.finish()",
    "    }",
    "    let other = mutableState.read(label: \\.activeRequests)",
    "    let all = mutableState.read(\\.self)",
    "  }",
    "}",
    "",
  ].join("\n");

  it("spells a lone unlabeled key-path argument and strips any other", () => {
    for (const out of [extract(src), extractMaterialized(src)]) {
      const bindings = out.chunks[0].callResultBindings ?? {};
      expect(bindings.requests).toEqual([{ line: 3, callee: "mutableState.read(\\.activeRequests)" }]);
      expect(bindings.other).toEqual([{ line: 7, callee: "mutableState.read" }]);
      expect(bindings.all).toEqual([{ line: 8, callee: "mutableState.read(\\.self)" }]);
    }
  });

  it("records a for-in item over an untyped local as an element of its spelling", () => {
    for (const out of [extract(src), extractMaterialized(src)]) {
      expect(out.chunks[0].callResultBindings?.request).toEqual([
        { line: 4, callee: "requests", sequenceElement: true, scopeEndLine: 6 },
      ]);
    }
  });

  it("records no element spelling when the walker already types the item", () => {
    const typed = ["func go(xs: [Thing]) {", "  for x in xs {", "    x.run()", "  }", "}", ""].join("\n");
    expect(extract(typed).chunks[0].callResultBindings?.x).toBeUndefined();
  });

  it("publishes the generic methods whose return is their closure's result", () => {
    const decl = [
      "final class Protected<Value> {",
      "  func read<U>(_ closure: (Value) throws -> U) rethrows -> U { fatalError() }",
      "  func write<U>(_ closure: (inout Value) throws -> U) rethrows -> U { fatalError() }",
      "  func write(_ value: Value) {}",
      "  func map<U>(_ closure: (Value) -> U) -> [U] { [] }",
      "  func around<T>(_ closure: () throws -> T) rethrows -> T { fatalError() }",
      "}",
      "",
    ].join("\n");
    for (const out of [extract(decl), extractMaterialized(decl)]) {
      // `write` has an overload that is not one; `map` wraps U; `around`'s closure takes no value.
      expect(out.typeDeclarations?.find((f) => f.typeId === "Protected")?.closureResultMembers).toEqual(["read"]);
    }
  });
});
