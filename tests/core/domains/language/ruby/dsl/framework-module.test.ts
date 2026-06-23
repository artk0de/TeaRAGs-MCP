import { describe, expect, it } from "vitest";

import { isExternalBareCall } from "../../../../../../src/core/domains/language/ruby/dsl/catalogue.js";
import { defineFrameworkVocabulary } from "../../../../../../src/core/domains/language/ruby/dsl/framework-module.js";

describe("defineFrameworkVocabulary", () => {
  const vocab = defineFrameworkVocabulary("demo", { has_many: { category: "association" } }, new Set(["render"]));

  it("hasExternalMember is true for an entry key (declaring macro)", () => {
    expect(vocab.hasExternalMember("has_many")).toBe(true);
  });
  it("hasExternalMember is true for a runtime builtin", () => {
    expect(vocab.hasExternalMember("render")).toBe(true);
  });
  it("hasExternalMember is false for an unknown member", () => {
    expect(vocab.hasExternalMember("create_event")).toBe(false);
  });
  it("treats omitted runtimeBuiltins as empty (no throw)", () => {
    const noRuntime = defineFrameworkVocabulary("x", { foo: { category: "other" } });
    expect(noRuntime.hasExternalMember("render")).toBe(false);
    expect(noRuntime.hasExternalMember("foo")).toBe(true);
  });
});

describe("isExternalBareCall (registry fold over FRAMEWORKS)", () => {
  it("is true for a Rails DSL macro, a Rails runtime helper, and a Kernel builtin", () => {
    expect(isExternalBareCall("has_many")).toBe(true); // rails entry
    expect(isExternalBareCall("params")).toBe(true); // rails runtime
    expect(isExternalBareCall("puts")).toBe(true); // ruby-core kernel
  });
  it("is false for a project method name", () => {
    expect(isExternalBareCall("create_event")).toBe(false);
  });
});
