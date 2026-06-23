import { describe, expect, it } from "vitest";

import { RUBY_DSL } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

describe("RUBY_DSL catalogue", () => {
  it("attr_accessor declares getter + setter (instance)", () => {
    const e = RUBY_DSL.attr_accessor;
    expect(e.category).toBe("accessor");
    expect(e.declares?.("foo")).toEqual([
      { name: "foo", kind: "instance" },
      { name: "foo=", kind: "instance" },
    ]);
  });

  it("cattr_accessor declares static getter + setter", () => {
    expect(RUBY_DSL.cattr_accessor.declares?.("x")).toEqual([
      { name: "x", kind: "static" },
      { name: "x=", kind: "static" },
    ]);
  });

  it("attr_reader / attr_writer declare a single accessor", () => {
    expect(RUBY_DSL.attr_reader.declares?.("a")).toEqual([{ name: "a", kind: "instance" }]);
    expect(RUBY_DSL.attr_writer.declares?.("a")).toEqual([{ name: "a=", kind: "instance" }]);
  });

  it("delegate declares one instance forwarder", () => {
    expect(RUBY_DSL.delegate.category).toBe("delegation");
    expect(RUBY_DSL.delegate.declares?.("name")).toEqual([{ name: "name", kind: "instance" }]);
  });

  it("define_method is a dynamic-method that declares one instance method", () => {
    expect(RUBY_DSL.define_method.category).toBe("dynamic-method");
    expect(RUBY_DSL.define_method.declares?.("run")).toEqual([{ name: "run", kind: "instance" }]);
  });

  it("alias_method is an alias with second-symbol redirect", () => {
    expect(RUBY_DSL.alias_method.category).toBe("alias");
    expect(RUBY_DSL.alias_method.declares?.("new_m")).toEqual([{ name: "new_m", kind: "instance" }]);
    expect(RUBY_DSL.alias_method.redirectTarget).toBe("second-symbol");
  });

  it("alias keyword is an alias with alias-keyword-old redirect", () => {
    expect(RUBY_DSL.alias.category).toBe("alias");
    expect(RUBY_DSL.alias.redirectTarget).toBe("alias-keyword-old");
  });

  it("group-only Rails keywords carry a category and NO declares/redirect", () => {
    // NOTE: associations + scope now CARRY declares (synthesised accessors) —
    // see rails.test.ts. The keywords below remain group-only (chunk grouping
    // and callback/redirect detection only).
    for (const kw of ["validates", "before_save", "include", "enum", "aasm", "included"]) {
      expect(RUBY_DSL[kw], kw).toBeDefined();
      expect(RUBY_DSL[kw].declares, kw).toBeUndefined();
      expect(RUBY_DSL[kw].redirectTarget, kw).toBeUndefined();
    }
    expect(RUBY_DSL.has_many.category).toBe("association");
    expect(RUBY_DSL.validates.category).toBe("validation");
    expect(RUBY_DSL.scope.category).toBe("scope");
    expect(RUBY_DSL.before_save.category).toBe("callback");
    expect(RUBY_DSL.accepts_nested_attributes_for.category).toBe("nested-attrs");
    expect(RUBY_DSL.aasm.category).toBe("state-machine");
    expect(RUBY_DSL.included.category).toBe("concern-hook");
  });

  it("accessor library macros (attribute, attachments, class_attribute) carry declares (Phase C)", () => {
    for (const kw of ["attribute", "class_attribute", "has_one_attached", "has_many_attached"]) {
      expect(RUBY_DSL[kw].category, kw).toBe("accessor");
      expect(RUBY_DSL[kw].declares, kw).toBeDefined();
    }
    // accepts_nested_attributes_for synthesises the `<name>_attributes=` writer.
    expect(RUBY_DSL.accepts_nested_attributes_for.declares).toBeDefined();
  });

  it("excludes RSpec / FactoryBot keywords (separate testing DSL)", () => {
    for (const kw of ["let", "subject", "before", "describe", "context", "it", "factory", "trait", "shared_examples"]) {
      expect(RUBY_DSL[kw], kw).toBeUndefined();
    }
  });

  it("composes keywords from every framework module exactly once", () => {
    expect(RUBY_DSL.attr_accessor?.category).toBe("accessor"); // ruby-core
    expect(RUBY_DSL.delegate?.category).toBe("delegation"); // activesupport
    expect(RUBY_DSL.has_many?.category).toBe("association"); // rails
    expect(RUBY_DSL.before_action?.category).toBe("callback"); // rails
  });
});

describe("composeEntries", () => {
  it("throws on a duplicate keyword across modules", async () => {
    const { composeEntries } = await import("../../../../../../src/core/domains/language/ruby/dsl/catalogue.js");
    const { defineFrameworkVocabulary } =
      await import("../../../../../../src/core/domains/language/ruby/dsl/framework-module.js");
    expect(() =>
      composeEntries([
        defineFrameworkVocabulary("a", { x: { category: "other" } }),
        defineFrameworkVocabulary("b", { x: { category: "other" } }),
      ]),
    ).toThrow(/duplicate keyword "x"/);
  });
});
