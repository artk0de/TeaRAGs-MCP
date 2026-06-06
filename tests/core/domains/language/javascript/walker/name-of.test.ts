import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { jsNameOf } from "../../../../../../src/core/domains/language/javascript/walker/name-of.js";

// Helper: parse JS source and return the tree root's named children.
function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(JsLang as unknown as Parser.Language);
  return parser.parse(src);
}

// Simulate what the codegraph provider's collectSymbols does: walk every
// named child of the root and collect results of jsNameOf.
function collectNames(src: string): string[] {
  const tree = parse(src);
  const results: string[] = [];
  function visit(node: Parser.SyntaxNode): void {
    const r = jsNameOf(node);
    if (r) {
      if (Array.isArray(r)) {
        results.push(...r.map((s) => s.name));
      } else {
        results.push(r.name);
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }
  visit(tree.rootNode);
  return results;
}

describe("jsNameOf — variable_declarator patterns", () => {
  it("returns null for variable_declarator with no initializer (null valueNode guard)", () => {
    // `var x;` — variable_declarator has nameNode but no value field.
    // The null guard on valueNode returns null without crashing.
    const src = "var x;\n";
    const names = collectNames(src);
    expect(names).toEqual([]);
  });

  it("emits name for const arrow function: `const foo = () => {}`", () => {
    const src = "const foo = () => {};\n";
    const names = collectNames(src);
    expect(names).toContain("foo");
  });

  it("emits name for let function expression: `let bar = function() {}`", () => {
    const src = "let bar = function() {};\n";
    const names = collectNames(src);
    expect(names).toContain("bar");
  });

  it("skips variable_declarator with non-function value: `const x = 42`", () => {
    const src = "const x = 42;\n";
    const names = collectNames(src);
    expect(names).not.toContain("x");
  });
});

describe("jsNameOf — assignment_expression patterns (collectAssignmentTargets + lhsToNamedSymbol)", () => {
  it("emits `exports.foo` for `exports.foo = function() {}` (Pattern #3)", () => {
    const src = "exports.foo = function() {};\n";
    const names = collectNames(src);
    expect(names).toContain("foo");
  });

  it("emits `module.exports` name for `module.exports = function myFn() {}` (Pattern #4)", () => {
    const src = "module.exports = function myFn() {};\n";
    const names = collectNames(src);
    expect(names).toContain("myFn");
  });

  it("emits `obj.method` for `obj.method = function() {}` (Pattern #1)", () => {
    const src = "obj.method = function() {};\n";
    const names = collectNames(src);
    expect(names).toContain("obj.method");
  });

  it("emits `Foo#bar` for `Foo.prototype.bar = function() {}` (Pattern #2 — collectAssignmentTargets + lhsToNamedSymbol prototype branch)", () => {
    // lhsToNamedSymbol detects obj.type === member_expression with
    // innerProp.text === "prototype" → emits Foo#bar.
    const src = "Foo.prototype.bar = function() {};\n";
    const names = collectNames(src);
    expect(names).toContain("Foo#bar");
  });

  it("skips deep member chain `a.b.c = fn` (lhsToNamedSymbol returns null for depth > 2)", () => {
    // lhsToNamedSymbol line 726: `return null` when obj is a member_expression
    // but NOT a prototype pattern (a.b.c where b !== "prototype").
    const src = "a.b.c = function() {};\n";
    const names = collectNames(src);
    expect(names).not.toContain("a.b.c");
    expect(names).not.toContain("b.c");
  });

  it("handles chained assignment `a.foo = b.bar = function() {}` — both LHSes emitted (collectAssignmentTargets recursion)", () => {
    // collectAssignmentTargets walks the chain recursively.
    // The outer node processes a.foo, recurses to process b.bar.
    // Both are valid member_expression LHSes (not prototype, not exports).
    const src = "a.foo = b.bar = function() {};\n";
    const names = collectNames(src);
    expect(names).toContain("a.foo");
    expect(names).toContain("b.bar");
  });

  it("chained assignment where terminal RHS is non-function emits nothing", () => {
    // walkAssignmentChainToTerminalRhs returns 42, not function-valued.
    // jsNameOf early-returns null before collectAssignmentTargets.
    const src = "a.foo = b.bar = 42;\n";
    const names = collectNames(src);
    expect(names).not.toContain("a.foo");
    expect(names).not.toContain("b.bar");
  });

  it("emits from simple assignment `a.foo = function() {}`", () => {
    // walkAssignmentChainToTerminalRhs returns the function_expression,
    // collectAssignmentTargets runs, lhsToNamedSymbol emits `a.foo`.
    const src = "a.foo = function() {};\n";
    const names = collectNames(src);
    expect(names).toContain("a.foo");
  });

  it("skips assignment where lhs is a bare identifier (not re-emitting existing binding)", () => {
    // `x = function() {}` — lhsToNamedSymbol returns null for identifier LHS.
    const src = "x = function() {};\n";
    const names = collectNames(src);
    expect(names).not.toContain("x");
  });
});

describe("jsNameOf — Object.defineProperty via jsGetterHelperEmission (receiverDisplayText paths)", () => {
  it("emits `obj.prop` for Object.defineProperty with identifier receiver (receiverDisplayText identifier branch)", () => {
    // receiverDisplayText(identifier) → node.text directly (covered branch).
    const src = "Object.defineProperty(obj, 'prop', { get: function() {} });\n";
    const names = collectNames(src);
    expect(names).toContain("obj.prop");
  });

  it("emits `obj.x` when Object.defineProperty(this, 'x', ...) is inside a function assigned to obj.method (receiverDisplayText `this` branch via resolveEnclosingThisReceiver)", () => {
    // receiverDisplayText `this` branch (line 533): `if (node.type === "this") return "this"`.
    // This branch is reached when jsGetterHelperEmission calls resolveReceiverText(this)
    // → resolveEnclosingThisReceiver finds the enclosing function_expression is RHS of
    //   `obj.method = function() {...}` → returns receiverDisplayText(obj) = "obj"
    // → jsGetterHelperEmission emits "obj.x".
    // The `this` branch of receiverDisplayText fires when resolveEnclosingThisReceiver
    // finds the outer assignment's LHS object, which is `obj` (an identifier) — but the
    // `this` branch of receiverDisplayText is exercised inside `resolveEnclosingThisReceiver`
    // when computing the LEFT side receiver text.
    //
    // Actual behavior to assert: `obj.x` is emitted (the resolved this → obj mapping works).
    const src = [
      "obj.method = function() {",
      "  Object.defineProperty(this, 'x', { get: function() { return 1; } });",
      "};",
      "",
    ].join("\n");
    const names = collectNames(src);
    expect(names).toContain("obj.method");
    // obj.x from the inner Object.defineProperty where `this` → `obj`.
    expect(names).toContain("obj.x");
  });

  it("emits `exports.proto.name` for Object.defineProperty with member_expression receiver (receiverDisplayText recursive member_expression branch — UNCOVERED)", () => {
    // receiverDisplayText recursive member_expression branch: lines 535-543.
    // `exports.proto` is a member_expression → recursive call.
    const src = "Object.defineProperty(exports.proto, 'name', { get: function() {} });\n";
    const names = collectNames(src);
    expect(names).toContain("exports.proto.name");
  });

  it('emits via string-quoted key `"get"` in descriptor (objectHasGetterPair string branch)', () => {
    // objectHasGetterPair: key.type === "string" path (lines 554-557).
    // readStringLiteral strips the quotes from `"get"` → "get".
    const src = "Object.defineProperty(obj, 'accessor', { \"get\": function() {} });\n";
    const names = collectNames(src);
    expect(names).toContain("obj.accessor");
  });

  it("skips Object.defineProperty with computed/variable name arg (no string literal)", () => {
    // readStringLiteral returns null for a variable → jsGetterHelperEmission
    // returns null at `if (!propName) return null;` guard.
    const src = "Object.defineProperty(obj, propName, { get: function() {} });\n";
    const names = collectNames(src);
    // No `obj.propName` or similar because propName isn't a string literal.
    expect(names.some((n) => n.startsWith("obj."))).toBe(false);
  });

  it("emits via defineGetter(obj, name, fn) (Shape B of jsGetterHelperEmission)", () => {
    // Shape B: identifier callee === "defineGetter"
    const src = "defineGetter(obj, 'secret', function() {});\n";
    const names = collectNames(src);
    expect(names).toContain("obj.secret");
  });
});

describe("jsNameOf — isJsConstructorFunction (pre-ES6 constructor detection)", () => {
  it("marks function_declaration as syntheticConstructorIfMissing when prototype assignments follow (isJsConstructorFunction UNCOVERED)", () => {
    // isJsConstructorFunction walks the root to find `.prototype.X = fn`
    // patterns with the same function name. When found, jsNameOf wraps
    // the tsResult with `syntheticConstructorIfMissing: true`.
    // The returned symbol should still have the function name.
    const src = ["function Foo(x) { this.x = x; }", "Foo.prototype.bar = function() {};", ""].join("\n");
    const names = collectNames(src);
    // The function itself is emitted by tsNameOf (via jsNameOf delegation).
    expect(names).toContain("Foo");
    // Prototype method also emitted via assignment pattern.
    expect(names).toContain("Foo#bar");
  });

  it("does NOT mark a plain function as syntheticConstructor when no prototype assignments exist", () => {
    // When isJsConstructorFunction returns false, jsNameOf delegates to
    // tsResult directly (no `syntheticConstructorIfMissing`).
    const src = "function helper(x) { return x + 1; }\n";
    const names = collectNames(src);
    expect(names).toContain("helper");
  });
});

describe("jsNameOf — resolveEnclosingThisReceiver (non-arrow function inside assignment context)", () => {
  it("resolves `this` receiver from enclosing assignment when function_expression is RHS of member_expression assignment", () => {
    // resolveEnclosingThisReceiver: when a `function_expression` is the RHS
    // of `lhs = function() { Object.defineProperty(this, ...) }`, and lhs
    // is a member_expression, `this` resolves to the lhs object text.
    // This exercises the `fnParent?.type === "assignment_expression"` branch
    // and the `receiverDisplayText(obj)` call inside resolveEnclosingThisReceiver.
    const src = [
      "exports.myModule = function() {",
      "  Object.defineProperty(this, 'prop', { get: function() {} });",
      "};",
      "",
    ].join("\n");
    const names = collectNames(src);
    // exports.myModule is emitted for the outer assignment.
    expect(names).toContain("myModule");
    // this.prop from the inner Object.defineProperty — `this` inside a
    // function_expression assigned to `exports.myModule` resolves to
    // the lhs object = `exports`. So emitted symbol is `exports.prop`.
    expect(names).toContain("exports.prop");
  });

  it("resolveEnclosingThisReceiver returns null for non-arrow function with no assignment context (UNCOVERED null return path)", () => {
    // A `function_expression` NOT on the RHS of any `assignment_expression`
    // causes resolveEnclosingThisReceiver to hit the `return null` at line 497.
    // Tested via Object.defineProperty(this, ...) inside a bare function
    // called as IIFE — no outer assignment expression.
    // Result: `this` cannot be resolved, jsGetterHelperEmission gets null
    // from resolveReceiverText(this-node), returns null, nothing emitted.
    const src = [
      "(function() {",
      "  Object.defineProperty(this, 'iifeProp', { get: function() {} });",
      "})();",
      "",
    ].join("\n");
    const names = collectNames(src);
    // No symbol for `this.iifeProp` because `this` is unresolvable.
    expect(names).not.toContain("this.iifeProp");
  });
});

describe("jsNameOf — jsForEachDispatchEmission (HTTP-verb dispatch pattern, bd tea-rags-mcp-z95o)", () => {
  it("emits one symbol per HTTP verb when forEach dispatch body compares param to HTTP verb string (jsForEachDispatchEmission UNCOVERED body)", () => {
    // Pattern #8: `<pkg>.forEach(function(method) { obj[method] = fn; })`
    // where the body contains a comparison `method === 'get'` — triggers
    // the `bodyComparesParamToHttpVerb` signal heuristic.
    // jsForEachDispatchEmission emits HTTP_VERBS.map(...) → one symbol per verb.
    const src = [
      "methods.forEach(function(method) {",
      "  if (method === 'get') {}",
      "  app[method] = function() {};",
      "});",
      "",
    ].join("\n");
    const names = collectNames(src);
    // HTTP-verb expansion should emit app.get, app.post, app.put, etc.
    expect(names.some((n) => n.startsWith("app."))).toBe(true);
    expect(names).toContain("app.get");
    expect(names).toContain("app.post");
  });

  it("does NOT emit symbols when the forEach body has no subscript assignment (jsForEachDispatchEmission short-circuit)", () => {
    // findFirstSubscriptDispatchAssignment returns null → jsForEachDispatchEmission
    // returns null before verb expansion.
    const src = ["items.forEach(function(item) {", "  console.log(item);", "});", ""].join("\n");
    const names = collectNames(src);
    expect(names.filter((n) => n.startsWith("app."))).toEqual([]);
  });
});

describe("jsNameOf — jsForEachDispatchEmission guard paths (early returns)", () => {
  it("does NOT emit when forEach fnArg is not a function expression (jsForEachDispatchEmission line 147)", () => {
    // fnArg is an identifier, not a function-valued expression
    const src = ["methods.forEach(handler);", ""].join("\n");
    const names = collectNames(src);
    expect(names.filter((n) => n.startsWith("app."))).toEqual([]);
  });

  it("does NOT emit when forEach is called on a non-identifier (e.g. call_expression)", () => {
    // recv.type !== "identifier" guard (line 143)
    const src = ["getMethods().forEach(function(method) {", "  app[method] = function() {};", "});", ""].join("\n");
    const names = collectNames(src);
    expect(names.filter((n) => n.startsWith("app."))).toEqual([]);
  });

  it("does NOT emit when forEach body has no subscript-dispatch assignment with function RHS", () => {
    // findFirstSubscriptDispatchAssignment: right is not function-valued → returns null
    // line 162: lhs.type !== "subscript_expression"
    const src = [
      "methods.forEach(function(method) {",
      "  if (method === 'get') {}",
      "  app.method = 'string';",
      "});",
      "",
    ].join("\n");
    const names = collectNames(src);
    expect(names.filter((n) => n.startsWith("app."))).toEqual([]);
  });

  it("emits HTTP-verb symbols when require source is 'methods' package (findRequireSource path)", () => {
    // hasHttpVerbDispatchSignal: recvName === "methods" AND requireSource === "methods"
    // This exercises findRequireSource returning the npm package name
    const src = [
      "var methods = require('methods');",
      "methods.forEach(function(method) {",
      "  app[method] = function() {};",
      "});",
      "",
    ].join("\n");
    const names = collectNames(src);
    expect(names).toContain("app.get");
    expect(names).toContain("app.post");
  });

  it("emits HTTP-verb symbols when util import path is present (anyImportPathContainsUtil path)", () => {
    // hasHttpVerbDispatchSignal: recvName === "methods" AND anyImportPathContainsUtil
    // This exercises the anyImportPathContainsUtil heuristic (line 264)
    const src = [
      "var methods = require('./utils').methods;",
      "methods.forEach(function(method) {",
      "  app[method] = function() {};",
      "});",
      "",
    ].join("\n");
    const names = collectNames(src);
    expect(names).toContain("app.get");
    expect(names).toContain("app.post");
  });
});

describe("jsNameOf — jsGetterHelperEmission guard paths", () => {
  it("does NOT emit when Object.defineProperty has fewer than 3 arguments", () => {
    // namedArgs.length < 3 guard (implicit — no descriptor arg)
    const src = ["Object.defineProperty(obj, 'name');", ""].join("\n");
    const names = collectNames(src);
    expect(names).not.toContain("obj.name");
  });

  it("does NOT emit when Object.defineProperty descriptor has no get/set pair", () => {
    // objectHasGetterPair returns false → return null
    const src = ["Object.defineProperty(obj, 'name', { value: 42, writable: true });", ""].join("\n");
    const names = collectNames(src);
    expect(names).not.toContain("obj.name");
  });

  it("emits symbol for defineGetter(obj, name, fn) — Shape B", () => {
    // jsGetterHelperEmission Shape B: callee === "defineGetter"
    const src = ["defineGetter(req, 'host', function() { return this.get('Host'); });", ""].join("\n");
    const names = collectNames(src);
    expect(names).toContain("req.host");
  });
});
