/**
 * JavaScript chunker hook symbol resolver tests.
 *
 * Targets the three exported helpers in
 * `src/core/domains/language/javascript/chunking/symbol-resolver.ts`:
 *
 *   - extractJsAssignmentSymbol — single-symbol resolution for the
 *     classic assignment + lexical declaration shapes (`exports.foo =`,
 *     `Foo.prototype.bar =`, `module.exports = function …`,
 *     `Object.defineProperty(obj, 'name', { get })`, etc.).
 *   - extractJsForEachDispatchSymbols — the
 *     `methods.forEach(method => obj[method] = fn)` HTTP-verb dispatch
 *     idiom (bd tea-rags-mcp-z95o).
 *   - extractJsNestedDefinePropertyThisSymbols — `this`-rebind for
 *     `app.init = function () { Object.defineProperty(this, …) }`
 *     (bd tea-rags-mcp-d1f8).
 *
 * The chunker uses the symbol resolver to write the Qdrant payload
 * `symbolId` for each chunkable node; it MUST match
 * `provider.ts:jsNameOf` for the same physical AST node — these tests
 * pin the resolver's surface so the contract holds.
 */

import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import {
  extractJsAssignmentSymbol,
  extractJsForEachDispatchSymbols,
  extractJsNestedDefinePropertyThisSymbols,
} from "../../../../../../src/core/domains/language/javascript/chunking/symbol-resolver.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(JsLang as unknown as Parser.Language);
  return parser.parse(src);
}

function topLevel(src: string, type: string): Parser.SyntaxNode {
  const tree = parse(src);
  const node = tree.rootNode.namedChildren.find((c) => c.type === type);
  if (!node) throw new Error(`No ${type} found in:\n${src}`);
  return node;
}

describe("extractJsAssignmentSymbol — assignment shapes", () => {
  it("Pattern #1: obj.method = fn → 'obj.method'", () => {
    const stmt = topLevel("obj.method = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "obj.method", name: "obj.method" });
  });

  it("Pattern #2: Foo.prototype.bar = fn → 'Foo#bar' (instance separator)", () => {
    const stmt = topLevel("Foo.prototype.bar = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "Foo#bar", name: "Foo#bar" });
  });

  it("Pattern #3: exports.foo = fn → 'foo' (top-level)", () => {
    const stmt = topLevel("exports.foo = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "foo", name: "foo" });
  });

  it("Pattern #4: module.exports = function name() {} → 'name'", () => {
    const stmt = topLevel("module.exports = function name() {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "name", name: "name" });
  });

  it("Pattern #4 with anonymous function — returns null (no name to emit)", () => {
    const stmt = topLevel("module.exports = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("Pattern #5: const Foo = function () {} → 'Foo'", () => {
    const stmt = topLevel("const Foo = function () {};\n", "lexical_declaration");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "Foo", name: "Foo" });
  });

  it("Pattern #5: arrow form `const Bar = () => {}` → 'Bar'", () => {
    const stmt = topLevel("const Bar = () => {};\n", "lexical_declaration");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "Bar", name: "Bar" });
  });

  it("lexical_declaration with non-function value returns null", () => {
    const stmt = topLevel("const x = 1;\n", "lexical_declaration");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("bare identifier reassignment (x = fn) returns null (duplicate-with-declaration guard)", () => {
    const stmt = topLevel("x = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("deep member chain (a.b.c.d = fn) returns null when not prototype-shaped", () => {
    const stmt = topLevel("a.b.c.d = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("non-assignment non-declaration node returns null", () => {
    const stmt = topLevel("foo();\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });
});

describe("extractJsAssignmentSymbol — Object.defineProperty getter helper", () => {
  it("Object.defineProperty(obj, 'name', { get: fn }) → 'obj.name'", () => {
    const src = "Object.defineProperty(obj, 'name', { get: function () {} });\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "obj.name", name: "obj.name" });
  });

  it("defineGetter(obj, 'name', fn) → 'obj.name'", () => {
    const src = "defineGetter(obj, 'name', function () {});\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "obj.name", name: "obj.name" });
  });

  it("Object.defineProperty without get/set in descriptor returns null", () => {
    const src = "Object.defineProperty(obj, 'name', { value: 1 });\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("defineGetter with non-function third arg returns null", () => {
    const src = "defineGetter(obj, 'name', 42);\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("defineProperty with member-expression receiver (`obj.proto`) preserves the full chain", () => {
    const src = "Object.defineProperty(obj.proto, 'name', { get: function () {} });\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({
      symbolId: "obj.proto.name",
      name: "obj.proto.name",
    });
  });

  // Nested case: when `extractJsAssignmentSymbol` is called on an
  // expression_statement that lives INSIDE an outer
  // `<receiver>.<member> = function () {...}` assignment AND contains
  // `Object.defineProperty(this, ...)`, the `this` receiver rebinds
  // to the outer assignment's receiver (resolveEnclosingThisReceiver).
  // Mirrors provider.ts:resolveReceiverText `this` branch.
  it("Object.defineProperty(this, 'name', { get }) inside outer fn rebinds `this` to enclosing receiver", () => {
    const src = `
      app.init = function () {
        Object.defineProperty(this, 'router', { get: function () {} });
      };
    `;
    // Find the inner expression_statement wrapping defineProperty.
    const tree = parse(src);
    const outer = tree.rootNode.namedChildren.find((c) => c.type === "expression_statement");
    if (!outer) throw new Error("outer not found");
    // outer → assignment_expression → function_expression → statement_block → expression_statement
    const assign = outer.children.find((c) => c.type === "assignment_expression");
    const fn = assign?.childForFieldName("right");
    const body = fn?.childForFieldName("body");
    const inner = body?.namedChildren.find((c) => c.type === "expression_statement");
    if (!inner) throw new Error("inner not found");
    expect(extractJsAssignmentSymbol(inner)).toEqual({ symbolId: "app.router", name: "app.router" });
  });

  // `defineGetter(this, 'x', fn)` nested in the same way — exercises
  // the matching resolveEnclosingThisReceiver branch for defineGetter.
  it("defineGetter(this, 'name', fn) inside outer fn rebinds `this` to enclosing receiver", () => {
    const src = `
      app.init = function () {
        defineGetter(this, 'name', function () {});
      };
    `;
    const tree = parse(src);
    const outer = tree.rootNode.namedChildren.find((c) => c.type === "expression_statement");
    if (!outer) throw new Error("outer not found");
    const assign = outer.children.find((c) => c.type === "assignment_expression");
    const fn = assign?.childForFieldName("right");
    const body = fn?.childForFieldName("body");
    const inner = body?.namedChildren.find((c) => c.type === "expression_statement");
    if (!inner) throw new Error("inner not found");
    expect(extractJsAssignmentSymbol(inner)).toEqual({ symbolId: "app.name", name: "app.name" });
  });

  // `this` at top level (no enclosing function) — resolveReceiverText
  // returns null; getterHelperSymbolId returns null; the whole
  // extractor returns null. Defensive coverage for the unresolvable case.
  it("Object.defineProperty(this, 'name', { get }) at top level (no enclosing fn) returns null", () => {
    const src = "Object.defineProperty(this, 'name', { get: function () {} });\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });
});

describe("extractJsForEachDispatchSymbols — HTTP verb dispatch (bd tea-rags-mcp-z95o)", () => {
  it("emits one symbol per HTTP verb when body compares param to verb literal", () => {
    // Strongest signal: body compares the loop param to an HTTP-verb
    // string literal (`method === 'get'`). That alone unlocks dispatch.
    const src = `
      methods.forEach(function (method) {
        if (method === 'get') return;
        app[method] = function () {};
      });
    `;
    const stmt = topLevel(src, "expression_statement");
    const out = extractJsForEachDispatchSymbols(stmt);
    expect(out).not.toBeNull();
    // 9 HTTP verbs declared in HTTP_VERBS.
    expect(out!.map((s) => s.symbolId)).toEqual([
      "app.get",
      "app.post",
      "app.put",
      "app.delete",
      "app.head",
      "app.options",
      "app.patch",
      "app.connect",
      "app.trace",
    ]);
  });

  it("emits dispatch symbols when receiver is `methods` and a require('methods') sibling exists", () => {
    const src = `
      var methods = require('methods');
      methods.forEach(function (method) {
        app[method] = function () {};
      });
    `;
    // Need to find the forEach expression_statement (NOT the require line).
    const tree = parse(src);
    const stmts = tree.rootNode.namedChildren.filter((c) => c.type === "expression_statement");
    expect(stmts).toHaveLength(1);
    const out = extractJsForEachDispatchSymbols(stmts[0]);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(9);
  });

  it("emits dispatch symbols when receiver is `methods` and a sibling require('./util') exists", () => {
    const src = `
      var methods = require('./util/methods');
      methods.forEach(function (method) {
        app[method] = function () {};
      });
    `;
    const tree = parse(src);
    const stmts = tree.rootNode.namedChildren.filter((c) => c.type === "expression_statement");
    expect(stmts).toHaveLength(1);
    const out = extractJsForEachDispatchSymbols(stmts[0]);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(9);
  });

  it("returns null when no HTTP-verb signal is present (arbitrary forEach without verb signal)", () => {
    // Receiver is NOT 'methods', body has NO verb-literal comparison —
    // signal-less forEach does not trigger HTTP-verb expansion.
    const src = `
      arr.forEach(function (item) {
        registry[item] = function () {};
      });
    `;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("returns null when forEach receiver is not a member_expression (e.g. bare call)", () => {
    const src = "forEach(fn);\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("returns null for an arrow callback with the wrong arity (zero or many params)", () => {
    const src = `
      methods.forEach(function () {
        app['get'] = function () {};
      });
    `;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("returns null when the body assignment doesn't use the loop param as index", () => {
    // Subscript uses a hardcoded string, not the loop param — the
    // dispatch anchor never resolves.
    const src = `
      methods.forEach(function (method) {
        if (method === 'get') return;
        app['fixed'] = function () {};
      });
    `;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("returns null for a non-expression-statement node", () => {
    const tree = parse("const x = 1;\n");
    const decl = tree.rootNode.namedChildren[0];
    expect(extractJsForEachDispatchSymbols(decl)).toBeNull();
  });
});

describe("extractJsNestedDefinePropertyThisSymbols — this-rebind (bd tea-rags-mcp-d1f8)", () => {
  it("app.init = function () { Object.defineProperty(this, 'router', { get }) } → 'app.router'", () => {
    const src = `
      app.init = function () {
        Object.defineProperty(this, 'router', { get: function () {} });
      };
    `;
    const stmt = topLevel(src, "expression_statement");
    const out = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(out).toEqual([{ symbolId: "app.router", name: "app.router" }]);
  });

  it("nested defineGetter(this, 'name', fn) inside outer assignment → 'app.name'", () => {
    const src = `
      app.init = function () {
        defineGetter(this, 'name', function () {});
      };
    `;
    const stmt = topLevel(src, "expression_statement");
    const out = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(out).toEqual([{ symbolId: "app.name", name: "app.name" }]);
  });

  it("two nested defineProperty calls emit two distinct symbols", () => {
    const src = `
      app.init = function () {
        Object.defineProperty(this, 'a', { get: function () {} });
        Object.defineProperty(this, 'b', { get: function () {} });
      };
    `;
    const stmt = topLevel(src, "expression_statement");
    const out = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(out.map((s) => s.symbolId)).toEqual(["app.a", "app.b"]);
  });

  it("a deeper (non-arrow) nested function rebinds `this` — defineProperty inside is NOT collected", () => {
    // The visit() walker stops descending once it crosses an inner
    // non-arrow function. `this` inside binds to that inner function,
    // not the outer assignment LHS.
    const src = `
      app.init = function () {
        function inner () {
          Object.defineProperty(this, 'wrong', { get: function () {} });
        }
      };
    `;
    const stmt = topLevel(src, "expression_statement");
    const out = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(out).toEqual([]);
  });

  it("returns empty when no nested defineProperty(this, …) call exists", () => {
    const src = `app.init = function () { someOther(); };\n`;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("returns empty for a non-expression-statement node", () => {
    const tree = parse("const x = 1;\n");
    const decl = tree.rootNode.namedChildren[0];
    expect(extractJsNestedDefinePropertyThisSymbols(decl)).toEqual([]);
  });

  it("returns empty when outer RHS is not function-valued", () => {
    const src = "app.init = 42;\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("returns empty when outer LHS is a bare identifier (not member access)", () => {
    const src = "init = function () { Object.defineProperty(this, 'x', { get: function () {} }); };\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });
});

/**
 * Defensive-path coverage — the resolver returns null for every shape
 * that would otherwise emit a corrupt or duplicate symbolId. These tests
 * pin the null-return contract for the most surprising malformed /
 * unsupported shapes the parser can hand us.
 */
describe("extractJsAssignmentSymbol — defensive null returns", () => {
  it("computed property assignment `obj['x'] = fn` returns null (prop is not property_identifier)", () => {
    // tree-sitter parses obj['x'] as subscript_expression, not member_expression,
    // so this falls through to the same null branch as deep chains.
    const stmt = topLevel("obj['x'] = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("call-result LHS `getObj().method = fn` returns null (obj is not identifier)", () => {
    const stmt = topLevel("getObj().method = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("deep prototype chain `Foo.proto.prototype.bar = fn` emits `Foo.proto#bar` (recursive prototype scan)", () => {
    // The inner member_expression `Foo.proto.prototype` matches the
    // `.prototype.X` pattern; the symbol uses the receiver text up to
    // the prototype level + instance separator + property name.
    const stmt = topLevel("Foo.proto.prototype.bar = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "Foo.proto#bar", name: "Foo.proto#bar" });
  });

  it("`module.notExports = fn` returns null (module.X where X !== 'exports' falls to default obj.prop branch)", () => {
    // module.something = fn does not match the module.exports pattern; it
    // falls into Pattern #1 (obj.method) and emits `module.something`.
    const stmt = topLevel("module.config = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "module.config", name: "module.config" });
  });

  it("non-statement node returns null", () => {
    // Pass the program (root) node — not expression_statement, not lexical_declaration.
    const tree = parse("foo();\n");
    expect(extractJsAssignmentSymbol(tree.rootNode)).toBeNull();
  });

  it("lexical_declaration with non-identifier name (destructuring) returns null", () => {
    // `const { foo } = fn` — name is object_pattern, not identifier; the
    // resolver skips it (codegraph also doesn't emit a symbol here).
    const stmt = topLevel("const { foo } = function () {};\n", "lexical_declaration");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("expression_statement carrying a plain call (no assign, no getter helper) returns null", () => {
    // `app.init();` — bare call_expression that isn't a getter installer.
    const stmt = topLevel("app.init();\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("Object.defineProperty with member receiver `obj.proto` and `this` rebind at top-level → null", () => {
    // `this` at the top level has no enclosing assignment to rebind to.
    const stmt = topLevel("defineGetter(this, 'name', function () {});\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("template-string property name `Object.defineProperty(obj, `name`, { get })` → 'obj.name' (no-interpolation template accepted)", () => {
    const src = "Object.defineProperty(obj, `myProp`, { get: function () {} });\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toEqual({ symbolId: "obj.myProp", name: "obj.myProp" });
  });

  it("template-string with interpolation Object.defineProperty(obj, dyn-template, { get }) → null (dynamic name)", () => {
    // The source we feed to tree-sitter intentionally contains a JS template
    // literal with interpolation; we assemble it via String.fromCharCode for the
    // `${` so ESLint's no-template-curly-in-string rule does not flag the TS
    // string literal that holds the JS fixture.
    const dollar = String.fromCharCode(36);
    const src = `Object.defineProperty(obj, \`${dollar}{dyn}\`, { get: function () {} });\n`;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });
});

describe("extractJsForEachDispatchSymbols — defensive null returns", () => {
  it("returns null when forEach callback body lacks a subscript dispatch", () => {
    // Receiver `methods` AND verb literal in body, BUT the body never
    // assigns `obj[param] = fn` — the dispatch anchor is missing.
    const src = `
      methods.forEach(function (method) {
        if (method === 'get') console.log('hit');
      });
    `;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("returns null when callback is missing parameters (function () {} arity 0)", () => {
    // forEach(function () { ... }) — params is empty parameter list, paramIds.length !== 1.
    const src = "methods.forEach(function () { app['x'] = function () {}; });\n";
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("returns null when the dispatch lhs object is a member_expression, not identifier", () => {
    // app.router[method] = fn — object is a member_expression; emission
    // requires objNode.type === 'identifier'.
    const src = `
      methods.forEach(function (method) {
        if (method === 'get') return;
        app.router[method] = function () {};
      });
    `;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });
});

describe("extractJsNestedDefinePropertyThisSymbols — defensive null returns", () => {
  it("returns empty when outer LHS object is a deep member chain (receiverDisplayText handles `a.b`)", () => {
    // `mod.app.init = function () { defineProperty(this, 'x', { get: fn }) }`
    // — receiverDisplayText recurses through member_expression and yields
    // `mod.app`; the nested `this` rebinds to `mod.app` and emits `mod.app.x`.
    const src = `
      mod.app.init = function () {
        Object.defineProperty(this, 'x', { get: function () {} });
      };
    `;
    const stmt = topLevel(src, "expression_statement");
    const out = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(out).toEqual([{ symbolId: "mod.app.x", name: "mod.app.x" }]);
  });

  it("returns empty when nested call is Object.defineProperty(this, ..., { value: 1 }) (no getter pair)", () => {
    // The descriptor has no get/set fn-valued pair, so the nested call
    // doesn't qualify as a getter install — out stays empty.
    const src = `
      app.init = function () {
        Object.defineProperty(this, 'x', { value: 1 });
      };
    `;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("returns empty when nested defineGetter receiver is not `this`", () => {
    // The nested call uses `obj` as receiver (not `this`), so it's NOT a
    // `this`-rebind case — extractJsNestedDefinePropertyThisSymbols filters
    // by `namedArgs[0].type === 'this'`.
    const src = `
      app.init = function () {
        defineGetter(obj, 'x', function () {});
      };
    `;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("returns empty when nested call has fewer than 3 arguments", () => {
    // defineGetter(this, 'x') — only 2 args, defensive guard fires.
    const src = `
      app.init = function () {
        defineGetter(this, 'x');
      };
    `;
    const stmt = topLevel(src, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });
});

describe("extractJsAssignmentSymbol — additional LHS guards", () => {
  it("computed subscript obj[k] = fn → null (prop not property_identifier)", () => {
    const stmt = topLevel("obj[k] = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("deep member chain a.b.c = fn (not anchored on prototype) → null", () => {
    const stmt = topLevel("a.b.c = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("call_expression as LHS object (f()).x = fn → null (obj not identifier)", () => {
    const stmt = topLevel("(f()).x = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("anonymous module.exports = function () {} → null (no name)", () => {
    const stmt = topLevel("module.exports = function () {};\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("lexical with rhs not function-valued → null", () => {
    const decl = topLevel("const X = 42;\n", "lexical_declaration");
    expect(extractJsAssignmentSymbol(decl)).toBeNull();
  });

  it("variable_declaration var Foo = function () {} → 'Foo'", () => {
    const decl = topLevel("var Foo = function () {};\n", "variable_declaration");
    expect(extractJsAssignmentSymbol(decl)).toEqual({ symbolId: "Foo", name: "Foo" });
  });

  it("lexical declarator with destructuring → null (name not identifier)", () => {
    const decl = topLevel("const { a } = function () { return { a: 1 }; }();\n", "lexical_declaration");
    expect(extractJsAssignmentSymbol(decl)).toBeNull();
  });

  it("returns null for non-supported node types (function_declaration)", () => {
    const fn = topLevel("function foo() {}\n", "function_declaration");
    expect(extractJsAssignmentSymbol(fn)).toBeNull();
  });

  it("getter helper Object.defineProperty descriptor not an object → null", () => {
    const stmt = topLevel("Object.defineProperty(obj, 'x', descriptor);\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("getter helper with insufficient args (2) → null", () => {
    const stmt = topLevel("Object.defineProperty(obj, 'x');\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("defineGetter with non-function third arg → null", () => {
    const stmt = topLevel("defineGetter(obj, 'x', 42);\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("defineGetter with non-string name arg → null", () => {
    const stmt = topLevel("defineGetter(obj, dynamicName, function () {});\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("unrecognised callee (not defineProperty / defineGetter) → null", () => {
    const stmt = topLevel("someHelper(obj, 'x', function () {});\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });

  it("Object.defineProperty descriptor object without get/set pair → null", () => {
    const stmt = topLevel("Object.defineProperty(obj, 'x', { value: 42 });\n", "expression_statement");
    expect(extractJsAssignmentSymbol(stmt)).toBeNull();
  });
});

describe("extractJsForEachDispatchSymbols — additional guards", () => {
  it("non-expression-statement → null", () => {
    const fn = topLevel("function f() {}\n", "function_declaration");
    expect(extractJsForEachDispatchSymbols(fn)).toBeNull();
  });

  it("expression_statement without call → null", () => {
    const stmt = topLevel("x;\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("non-member callee (bare forEach) → null", () => {
    const stmt = topLevel("forEach(function (x) { obj[x] = function () {}; });\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("method is not 'forEach' (e.g. map) → null", () => {
    const stmt = topLevel("methods.map(function (m) { obj[m] = function () {}; });\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("receiver is member_expression a.b.forEach → null (receiver not identifier)", () => {
    const stmt = topLevel("a.b.forEach(function (m) { obj[m] = function () {}; });\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("forEach with no args → null", () => {
    const stmt = topLevel("methods.forEach();\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("forEach callback is variable ref (not function) → null", () => {
    const stmt = topLevel("methods.forEach(cb);\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("callback with zero params → null", () => {
    const stmt = topLevel("methods.forEach(function () { obj.x = function () {}; });\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("callback with multiple params (m, i) → null", () => {
    const stmt = topLevel("methods.forEach(function (m, i) { obj[m] = function () {}; });\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("body lacks subscript dispatch (only comparison) → null", () => {
    const stmt = topLevel("methods.forEach(function (m) { if (m === 'get') {} });\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("subscript index is literal not the param → null", () => {
    const stmt = topLevel("methods.forEach(function (m) { obj['get'] = function () {}; });\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("non-methods receiver, no util-import, no body literal → null", () => {
    const stmt = topLevel("verbs.forEach(function (v) { obj[v] = function () {}; });\n", "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt)).toBeNull();
  });

  it("methods receiver + util require + dispatch body → emits HTTP_VERBS", () => {
    const tree = parse(
      "var methods = require('./utils').methods;\nmethods.forEach(function (m) { obj[m] = function () { return this.route(m); }; });\n",
    );
    const stmts = tree.rootNode.children.filter((c) => c.type === "expression_statement");
    const stmt = stmts[stmts.length - 1];
    const result = extractJsForEachDispatchSymbols(stmt);
    expect(result?.length).toBe(9);
    expect(result?.map((r) => r.symbolId).sort()).toEqual(
      [
        "obj.connect",
        "obj.delete",
        "obj.get",
        "obj.head",
        "obj.options",
        "obj.patch",
        "obj.post",
        "obj.put",
        "obj.trace",
      ].sort(),
    );
  });
});

describe("extractJsNestedDefinePropertyThisSymbols — additional guards", () => {
  it("rhs is arrow_function (not function_expression) → []", () => {
    const stmt = topLevel(
      "app.init = () => { Object.defineProperty(this, 'router', { get: function () {} }); };\n",
      "expression_statement",
    );
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("lhs is bare identifier (not member_expression) → []", () => {
    const stmt = topLevel(
      "app = function () { Object.defineProperty(this, 'x', { get: function () {} }); };\n",
      "expression_statement",
    );
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("nested defineProperty receiver not `this` (other identifier) → skipped", () => {
    const stmt = topLevel(
      "app.init = function () { Object.defineProperty(other, 'x', { get: function () {} }); };\n",
      "expression_statement",
    );
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("nested defineProperty inside deeper non-arrow function (this rebinds) → skipped", () => {
    const stmt = topLevel(
      "app.init = function () { (function inner() { Object.defineProperty(this, 'x', { get: function () {} }); })(); };\n",
      "expression_statement",
    );
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("nested defineProperty descriptor without get/set → skipped", () => {
    const stmt = topLevel(
      "app.init = function () { Object.defineProperty(this, 'x', { value: 1 }); };\n",
      "expression_statement",
    );
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("nested defineGetter with non-function third arg → skipped", () => {
    const stmt = topLevel("app.init = function () { defineGetter(this, 'x', 42); };\n", "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("nested defineProperty with non-string name (dynamic ident) → skipped", () => {
    const stmt = topLevel(
      "app.init = function () { Object.defineProperty(this, dyn, { get: function () {} }); };\n",
      "expression_statement",
    );
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("rhs not function (value) → []", () => {
    const stmt = topLevel("app.init = 42;\n", "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });

  it("receiverText is multi-level member chain → emits using chain text", () => {
    const stmt = topLevel(
      "outer.app.init = function () { Object.defineProperty(this, 'router', { get: function () {} }); };\n",
      "expression_statement",
    );
    const result = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(result).toEqual([{ symbolId: "outer.app.router", name: "outer.app.router" }]);
  });
});

// resolveEnclosingThisReceiver — `this` receiver in symbol-resolver.ts
// `extractJsNestedDefinePropertyThisSymbols` collects `Object.defineProperty(this, …)`
// and `defineGetter(this, …)` calls inside function_expression bodies.
// The `resolveEnclosingThisReceiver` is exercised through the resolver's own
// visitor when `this` appears in a nested defineProperty call.
describe("extractJsNestedDefinePropertyThisSymbols — this-receiver paths", () => {
  it("emits symbol when this-defineProperty is nested inside another property function body", () => {
    // obj.router = function () { Object.defineProperty(this, 'path', { get: fn }) }
    // The outer function is function_expression → resolveEnclosingThisReceiver
    // walks up and resolves `this` to `obj`.
    const stmt = topLevel(
      "obj.router = function () { Object.defineProperty(this, 'path', { get: function () { return '/'; } }); };\n",
      "expression_statement",
    );
    const result = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(result).toEqual([{ symbolId: "obj.path", name: "obj.path" }]);
  });

  it("emits symbol when defineGetter(this, name, fn) is used inside a function body", () => {
    // defineGetter(this, 'status', fn) inside an outer function assignment.
    const stmt = topLevel(
      "app.middleware = function () { defineGetter(this, 'status', function () { return 200; }); };\n",
      "expression_statement",
    );
    const result = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(result).toEqual([{ symbolId: "app.status", name: "app.status" }]);
  });

  it("skips nested defineProperty whose descriptor has no getter/setter", () => {
    // data descriptor only — no accessor — resolveEnclosingThisReceiver branch
    // reached but objectHasGetterPair returns false → symbol not emitted.
    const stmt = topLevel(
      "obj.init = function () { Object.defineProperty(this, 'x', { value: 1 }); };\n",
      "expression_statement",
    );
    expect(extractJsNestedDefinePropertyThisSymbols(stmt)).toEqual([]);
  });
});

// objectHasGetterPair — `set`-keyed function in descriptor counts as getter pair.
// The existing tests cover `get`; this covers the `set`-only branch.
describe("extractJsAssignmentSymbol — Object.defineProperty with set-only descriptor", () => {
  it("recognises a set-only descriptor as an accessor and emits the symbol", () => {
    const stmt = topLevel(
      "Object.defineProperty(obj, 'flag', { set: function (v) { this._flag = v; } });\n",
      "expression_statement",
    );
    const r = extractJsAssignmentSymbol(stmt);
    expect(r).toEqual({ symbolId: "obj.flag", name: "obj.flag" });
  });
});

// resolveReceiverText + resolveEnclosingThisReceiver — `this` via defineGetter
// when receiver is `this` and enclosing function has assignment context.
describe("extractJsAssignmentSymbol — defineGetter with this receiver", () => {
  it("emits <receiver>.<name> symbol for defineGetter(this, name, fn) inside assignment function", () => {
    // The expression_statement wraps `obj.setup = function() { defineGetter(this, 'prop', fn) }`.
    // extractJsNestedDefinePropertyThisSymbols handles the outer level; here we verify
    // the symbol-resolver emits obj.prop correctly.
    const stmt = topLevel(
      "obj.setup = function () { defineGetter(this, 'prop', function () { return 1; }); };\n",
      "expression_statement",
    );
    const result = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(result).toEqual([{ symbolId: "obj.prop", name: "obj.prop" }]);
  });
});

describe("extractJsForEachDispatchSymbols — guard paths (early returns)", () => {
  it("returns null when forEach fnArg is a non-function identifier (isFunctionValuedExpression false)", () => {
    // line 249: !fnArg || !isFunctionValuedExpression(fnArg) → return null
    const stmt = topLevel("methods.forEach(handler);\n", "expression_statement");
    const r = extractJsForEachDispatchSymbols(stmt);
    expect(r).toBeNull();
  });

  it("returns null when forEach receiver is a call_expression (not identifier)", () => {
    // line 245: recv.type !== "identifier" → return null
    const stmt = topLevel(
      "getMethods().forEach(function(method) { app[method] = function() {}; });\n",
      "expression_statement",
    );
    const r = extractJsForEachDispatchSymbols(stmt);
    expect(r).toBeNull();
  });

  it("returns null when forEach body has no function-valued subscript assignment", () => {
    // findFirstSubscriptDispatchAssignment: right is not function-valued → null
    // line 280: !dispatchLhs.node → return null
    const stmt = topLevel(
      "methods.forEach(function(method) { if (method === 'get') {} app.method = 'string'; });\n",
      "expression_statement",
    );
    const r = extractJsForEachDispatchSymbols(stmt);
    expect(r).toBeNull();
  });

  it("emits HTTP verbs when require('methods') is present (findRequireSource path)", () => {
    // hasHttpVerbDispatchSignal: recvName==="methods" && requireSource==="methods" → true
    const src = [
      "var methods = require('methods');",
      "methods.forEach(function(method) { app[method] = function() {}; });",
      "",
    ].join("\n");
    const tree = parse(src);
    // Find the expression_statement for the forEach call
    const root = tree.rootNode;
    let forEachStmt: Parser.SyntaxNode | null = null;
    for (const child of root.namedChildren) {
      if (child.type === "expression_statement" && child.text.includes("forEach")) {
        forEachStmt = child;
        break;
      }
    }
    expect(forEachStmt).not.toBeNull();
    const r = extractJsForEachDispatchSymbols(forEachStmt!);
    expect(r.map((s) => s.symbolId)).toContain("app.get");
    expect(r.map((s) => s.symbolId)).toContain("app.post");
  });
});

describe("extractJsNestedDefinePropertyThisSymbols — guard paths", () => {
  it("returns [] when outer assignment LHS is a plain identifier (not member_expression)", () => {
    // left.type !== "member_expression" guard (line 134)
    const stmt = topLevel(
      "init = function() { Object.defineProperty(this, 'x', { get: function() {} }); };\n",
      "expression_statement",
    );
    const r = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(r).toEqual([]);
  });

  it("returns [] for defineGetter(this, name, fn) where third arg is not function-valued (nestedGetterInstallThisName guard)", () => {
    // nestedGetterInstallThisName: fnArg not function-valued → return null → nothing pushed
    const src = "obj.setup = function() { defineGetter(this, 'prop', 42); };\n";
    const stmt = topLevel(src, "expression_statement");
    const r = extractJsNestedDefinePropertyThisSymbols(stmt);
    expect(r).toEqual([]);
  });
});
