import { describe, expect, it } from "vitest";

import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

describe("LanguageFactory.capabilities", () => {
  const factory = new LanguageFactory();

  it("has a capability descriptor for every supported() language", () => {
    const caps = factory.capabilities();
    for (const lang of factory.supported()) {
      expect(caps.has(lang)).toBe(true);
      expect(caps.get(lang)!.language).toBe(lang);
    }
  });

  it("covers exactly the supported() set (no extra, no missing)", () => {
    const caps = factory.capabilities();
    expect([...caps.keys()].sort()).toEqual([...factory.supported()].sort());
  });

  it("ports Ruby codegraph as a typing-tiered object", () => {
    const ruby = factory.capabilities().get("ruby")!;
    expect(ruby.codegraph.tier).toMatchObject({ untyped: "high", yard: "maximum", "rbs/sorbet": "tbd" });
  });

  it("ports markdown AST as partial and codegraph as none", () => {
    const md = factory.capabilities().get("markdown")!;
    expect(md.ast.tier).toBe("partial");
    expect(md.codegraph.tier).toBe("none");
  });
});
