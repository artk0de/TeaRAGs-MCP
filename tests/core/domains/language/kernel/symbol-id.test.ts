import { describe, expect, it } from "vitest";

import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";

/**
 * `DefaultSymbolIdComposer.compose` unifies two pre-existing symbolId builders
 * that MUST keep producing identical output (behavior-preserving extraction,
 * spec §1a):
 *   - chunker `tree-sitter.ts:buildSymbolId(name, parentName, isStatic)`
 *   - codegraph `provider.ts:joinSymbol(composed, child, scopeSeparator)`
 * Each block below mirrors one source function's cases.
 */
describe("DefaultSymbolIdComposer.compose", () => {
  const composer = new DefaultSymbolIdComposer();

  describe("top-level (no prefix)", () => {
    it("returns the bare name when prefix is empty", () => {
      expect(composer.compose("", "foo")).toBe("foo");
      expect(composer.compose("", "Foo", { methodKind: "instance" })).toBe("Foo");
    });
  });

  describe("method separators (# instance / . static)", () => {
    it("uses # for instance methods", () => {
      expect(composer.compose("Foo", "bar", { methodKind: "instance" })).toBe("Foo#bar");
    });
    it("uses . for static/class methods", () => {
      expect(composer.compose("Foo", "bar", { methodKind: "static" })).toBe("Foo.bar");
    });
  });

  describe("namespace separator (no methodKind)", () => {
    it("uses the language scopeSeparator for nested scopes", () => {
      expect(composer.compose("A::B", "C", { scopeSeparator: "::" })).toBe("A::B::C");
      expect(composer.compose("Outer", "Inner", { scopeSeparator: "." })).toBe("Outer.Inner");
    });
    it("defaults the namespace separator to '.' when omitted", () => {
      expect(composer.compose("Outer", "Inner")).toBe("Outer.Inner");
    });
  });

  describe("absolute escape (joinSymbol child.absolute)", () => {
    it("returns the name verbatim regardless of prefix or methodKind", () => {
      expect(composer.compose("app.init", "app.router", { absolute: true })).toBe("app.router");
      expect(composer.compose("Scope", "x", { absolute: true, methodKind: "instance" })).toBe("x");
    });
  });

  describe("mirrors buildSymbolId(name, parentName, isStatic)", () => {
    it("composes parent#method for instance (isStatic false)", () => {
      expect(composer.compose("Parent", "method", { methodKind: "instance" })).toBe("Parent#method");
    });
    it("composes parent.method for static (isStatic true)", () => {
      expect(composer.compose("Parent", "method", { methodKind: "static" })).toBe("Parent.method");
    });
  });

  describe("mirrors joinSymbol(composed, child, scopeSeparator)", () => {
    it("Ruby instance method on a namespaced class: Acme::User#save", () => {
      expect(composer.compose("Acme::User", "save", { methodKind: "instance", scopeSeparator: "::" })).toBe(
        "Acme::User#save",
      );
    });
    it("Rust namespace chain uses ::", () => {
      expect(composer.compose("crate::mod", "Type", { scopeSeparator: "::" })).toBe("crate::mod::Type");
    });
  });
});
