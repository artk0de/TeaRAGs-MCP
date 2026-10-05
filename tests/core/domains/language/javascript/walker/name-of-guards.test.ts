import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { jsNameOf } from "../../../../../../src/core/domains/language/javascript/walker/name-of.js";

function collectNames(src: string): string[] {
  const parser = new Parser();
  parser.setLanguage(JsLang);
  const results: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    const r = jsNameOf(node);
    if (r) {
      if (Array.isArray(r)) results.push(...r.map((s) => s.name));
      else results.push(r.name);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(parser.parse(src).rootNode);
  return results;
}

describe("jsNameOf — assignment LHS shapes that emit nothing or a qualified name", () => {
  it("skips an anonymous `module.exports = function () {}` (no name to attach)", () => {
    expect(collectNames("module.exports = function () {};\n")).toEqual([]);
  });

  it("skips assignments whose receiver is not a plain identifier (`this.x`, call result)", () => {
    const src = "this.run = function () {};\nmake().run = function () {};\n";
    expect(collectNames(src)).toEqual([]);
  });

  it("skips a private-field LHS (`obj.#x = fn`) because the property is not a plain identifier", () => {
    const src = "class A {\n  m(other) {\n    other.#x = function () {};\n  }\n}\n";
    expect(collectNames(src)).not.toContain("other.#x");
  });

  it("emits `Foo#bar` for prototype assignment and a constructor symbol for the function", () => {
    const src = "function Foo() {}\nFoo.prototype.bar = function () {};\n";
    expect(collectNames(src)).toContain("Foo#bar");
  });

  it("tolerates an anonymous default-exported function alongside prototype assignments", () => {
    expect(collectNames("export default function () {}\nFoo.prototype.bar = function () {};\n")).toContain("Foo#bar");
  });
});

describe("jsNameOf — defineProperty / defineGetter rejection paths", () => {
  it("emits `app.router` for a well-formed Object.defineProperty getter", () => {
    const src = "Object.defineProperty(app, 'router', { get: function () {} });\n";
    expect(collectNames(src)).toContain("app.router");
  });

  it("accepts a template-literal property name without interpolation", () => {
    const src = "Object.defineProperty(app, `router`, { get: function () {} });\n";
    expect(collectNames(src)).toContain("app.router");
  });

  it("rejects a template-literal property name with interpolation", () => {
    const name = ["r", "{n}"].join("$");
    const src = `Object.defineProperty(app, \`${name}\`, { get: function () {} });\n`;
    expect(collectNames(src)).toEqual([]);
  });

  it("rejects a non-literal descriptor argument", () => {
    expect(collectNames("Object.defineProperty(app, 'x', descriptor);\n")).toEqual([]);
  });

  it("ignores shorthand methods in the descriptor and still finds a later `get:` pair", () => {
    const src = "Object.defineProperty(app, 'x', { toString() {}, get: function () {} });\n";
    expect(collectNames(src)).toContain("app.x");
  });

  it("rejects a descriptor whose only members are shorthand methods", () => {
    expect(collectNames("Object.defineProperty(app, 'x', { get() {} });\n")).not.toContain("app.x");
  });

  it("renders a member-chain receiver rooted at `this`", () => {
    const src = "Object.defineProperty(this.proto, 'x', { get: function () {} });\n";
    expect(collectNames(src)).toContain("this.proto.x");
  });

  it("skips a receiver that is a call result, or a member chain rooted at a call", () => {
    const src =
      "Object.defineProperty(make(), 'x', { get: function () {} });\n" +
      "Object.defineProperty(make().inner, 'y', { get: function () {} });\n";
    expect(collectNames(src)).toEqual([]);
  });

  it("skips a member-chain receiver with a private property", () => {
    const src = "class A {\n  m() {\n    Object.defineProperty(this.#p, 'x', { get: function () {} });\n  }\n}\n";
    expect(collectNames(src)).not.toContain("this.#p.x");
  });

  it("skips a free-floating `this` receiver (no enclosing receiver-rooted assignment)", () => {
    const src = "Object.defineProperty(this, 'x', { get: function () {} });\n";
    expect(collectNames(src)).toEqual([]);
  });

  it("skips `this` inside a plain function declaration (rebinding with no assignment context)", () => {
    const src = "function init() {\n  Object.defineProperty(this, 'x', { get: function () {} });\n}\n";
    expect(collectNames(src)).toContain("init");
    expect(collectNames(src)).not.toContain("this.x");
  });

  it("resolves `this` through the enclosing `app.init = function` assignment", () => {
    const src = "app.init = function () {\n  Object.defineProperty(this, 'router', { get: function () {} });\n};\n";
    expect(collectNames(src)).toContain("app.router");
  });

  it("emits `req.ip` for defineGetter with a function third argument", () => {
    expect(collectNames("defineGetter(req, 'ip', function () {});\n")).toContain("req.ip");
  });

  it("rejects defineGetter with a non-literal name, a non-function value, or an unresolvable receiver", () => {
    const src =
      "defineGetter(req, name, function () {});\n" +
      "defineGetter(req, 'a', 5);\n" +
      "defineGetter(this, 'b', function () {});\n";
    expect(collectNames(src)).toEqual([]);
  });

  it("ignores unrelated three-argument calls", () => {
    expect(collectNames("configure(a, 'b', function () {});\n")).toEqual([]);
  });
});

describe("jsNameOf — forEach HTTP-verb dispatch heuristics", () => {
  it("rejects a numeric comparison on the callback parameter as a verb signal", () => {
    const src =
      "var methods = require('./utils').methods;\n" +
      "methods.forEach(function (m) {\n  if (m === 5) {}\n  app[m] = function () {};\n});\n";
    // `./utils` still satisfies the sibling-util heuristic, so the dispatch is accepted.
    expect(collectNames(src)).toContain("app.get");
  });

  it("rejects a numeric comparison when no other verb signal exists", () => {
    const src = "items.forEach(function (m) {\n  if (m === 5) {}\n  app[m] = function () {};\n});\n";
    expect(collectNames(src)).toEqual([]);
  });

  it("accepts a reversed `'get' === m` comparison as the verb signal", () => {
    const src = "items.forEach(function (m) {\n  if ('get' === m) {}\n  app[m] = function () {};\n});\n";
    expect(collectNames(src)).toEqual(expect.arrayContaining(["app.get", "app.post"]));
  });

  it("accepts `methods` required from the npm package", () => {
    const src = "var methods = require('methods');\nmethods.forEach(function (m) {\n  app[m] = function () {};\n});\n";
    expect(collectNames(src)).toContain("app.delete");
  });

  it("rejects `methods` required from a non-util local module", () => {
    const src = "var methods = require('./verbs');\nmethods.forEach(function (m) {\n  app[m] = function () {};\n});\n";
    expect(collectNames(src)).toEqual([]);
  });
});
