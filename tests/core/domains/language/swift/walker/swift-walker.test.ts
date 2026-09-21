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

  it("binds NOTHING for an array-returning function", () => {
    // Same invariant as an array annotation: the local is an Array, not a
    // Thing, and `LocalBinding.type` has no container slot to say so.
    const src = ["func all() -> [Thing] { [] }", "func go() {", "  let xs = all()", "  xs.append(y)", "}", ""].join(
      "\n",
    );
    expect(extract(src).chunks[0].localBindings?.xs).toBeUndefined();
  });
});

describe("extractFromSwiftFile — `for x in` element typing", () => {
  it("types the loop variable from an array-annotated parameter, and still binds NOTHING for the array", () => {
    const src = ["func go(xs: [Thing]) {", "  for x in xs {", "    x.touch()", "  }", "}", ""].join("\n");
    const bindings = extract(src).chunks[0].localBindings;
    expect(bindings?.x?.[0].type).toBe("Thing");
    expect(bindings?.xs).toBeUndefined();
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
    expect(r.classFieldTypes?.Store?.items).toBeUndefined();
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
    // ELEMENT and still no nominal of its own — the loop reads one, the
    // container rule keeps the other empty.
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
    expect(bindings?.list).toBeUndefined();
  });

  it("declines a Set, a dictionary and a tuple pattern", () => {
    const src = [
      "func go(s: Set<Thing>, d: [String: Foo]) {",
      "  for x in s { x.touch() }",
      "  for (k, v) in d { v.use() }",
      "}",
      "",
    ].join("\n");
    const bindings = extract(src).chunks[0].localBindings;
    expect(bindings?.x).toBeUndefined();
    expect(bindings?.k).toBeUndefined();
    expect(bindings?.v).toBeUndefined();
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

  it("does NOT record an array-typed or untyped literal property", () => {
    const src = ["class Store {", "  var items: [Thing] = []", "  var counter = 0", "}", ""].join("\n");
    expect(extract(src).classFieldTypes?.Store).toBeUndefined();
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
