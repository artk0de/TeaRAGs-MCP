/**
 * Swift declared visibility (bd tea-rags-mcp-jwjyr.1). `private` and
 * `fileprivate` → private (both are file-bounded); `internal`, `public`, `open`
 * and no modifier → public, because `internal` — the default — is module-wide.
 */
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import { declaredVisibilityOf } from "../../__helpers__/declared-visibility.js";
import { SwiftLanguage } from "../../../../../../src/core/domains/language/swift/index.js";

const grammar = (SwiftLang as { default?: unknown }).default ?? SwiftLang;
const visibilityOf = (src: string) => declaredVisibilityOf(new SwiftLanguage(), grammar, src, "A.swift", "swift");

describe("Swift walker — declared visibility", () => {
  it("maps private / fileprivate to private and internal / public / open / none to public", () => {
    const src = [
      "open class A {",
      "    private func a() {}",
      "    fileprivate func b() {}",
      "    internal func c() {}",
      "    public func d() {}",
      "    open func e() {}",
      "    func f() {}",
      "}",
      "",
    ].join("\n");
    expect(visibilityOf(src)).toEqual({
      A: "public",
      "A#a": "private",
      "A#b": "private",
      "A#c": "public",
      "A#d": "public",
      "A#e": "public",
      "A#f": "public",
    });
  });

  it("records a private type and a private top-level function", () => {
    const src = ["private struct Hidden {}", "fileprivate func helper() {}", ""].join("\n");
    expect(visibilityOf(src)).toEqual({ Hidden: "private", helper: "private" });
  });
});
