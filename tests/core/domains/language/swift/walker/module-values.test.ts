/**
 * Swift module-level values (bd tea-rags-mcp-y99pg.30). A file-scope `let` /
 * `var` is visible to every file of the module — Alamofire's
 * `public let AF = Session.default` is called as `AF.request(…)` from files
 * that never declare it — so the walker publishes it run-global under the
 * module-scope key `<relPath>::`: its type on `classFieldTypesByClassKey`
 * where the declaration spells one, else the right-hand side's SPELLING on
 * `classFieldCallResults` for the resolver to fold.
 *
 * Driven through the production seam (materialize, then the COMPOSED walker),
 * so the field-loss hazard `materializeTree` carries for tree-sitter-swift is
 * in scope of every assertion.
 */
import Parser from "tree-sitter";
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { SwiftLanguage } from "../../../../../../src/core/domains/language/swift/index.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

function extract(src: string) {
  const language = new SwiftLanguage();
  const parser = new Parser();
  parser.setLanguage(((SwiftLang as { default?: unknown }).default ?? SwiftLang) as Parser.Language);
  const tree = { rootNode: materializeTree(parser.parse(src).rootNode, src) };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath: "Source/Alamofire.swift", language: "swift", chunks });
}

describe("Swift walker — module-level values", () => {
  it("publishes an untyped module value's spelling under the module-scope key", () => {
    const r = extract(["import Foundation", "", "public let AF = Session.default", ""].join("\n"));
    expect(r.classFieldCallResults).toEqual({ "Source/Alamofire.swift::": { AF: "Session.default" } });
  });

  it("publishes a module value its declaration types on the type channel", () => {
    const r = extract(["let sharedStore = Store()", "var cache: Cache = makeCache()", ""].join("\n"));
    expect(r.classFieldTypesByClassKey?.["Source/Alamofire.swift::"]).toEqual({ sharedStore: "Store", cache: "Cache" });
    expect(r.classFieldCallResults).toBeUndefined();
  });

  it("publishes nothing for a file-private module value", () => {
    const r = extract(["private let hidden = Session.default", "fileprivate let other = Store()", ""].join("\n"));
    expect(r.classFieldCallResults).toBeUndefined();
    expect(r.classFieldTypesByClassKey?.["Source/Alamofire.swift::"]).toBeUndefined();
  });

  it("publishes no property or local of a type or function as a module value", () => {
    const src = [
      "final class Session {",
      "  static let shared = Session.default",
      "  func go() {",
      "    let local = Session.default",
      "  }",
      "}",
      "func top() {",
      "  let inner = Session.default",
      "}",
      "",
    ].join("\n");
    const r = extract(src);
    expect(r.classFieldCallResults).toBeUndefined();
    expect(r.classFieldTypesByClassKey?.["Source/Alamofire.swift::"]).toBeUndefined();
  });
});
