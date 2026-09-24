import { describe, expect, it } from "vitest";

import { UNSUPPORTED_FALLBACK } from "../../../../../src/core/domains/language/capability/fallback.js";
import { resolveLanguageCapabilities } from "../../../../../src/core/domains/language/capability/resolve.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

describe("resolveLanguageCapabilities", () => {
  const native = new LanguageFactory().capabilities();

  it("returns the native descriptor for every supported language, read from LanguageFactory.capabilities()", () => {
    const languages = [...native.keys()];
    const resolved = resolveLanguageCapabilities(languages);
    for (const language of languages) {
      expect(resolved.get(language)).toBe(native.get(language));
    }
  });

  it("maps a language with no native provider onto the unsupported-fallback descriptor", () => {
    const [fallback] = UNSUPPORTED_FALLBACK;
    const resolved = resolveLanguageCapabilities(["kotlin"]).get("kotlin");
    expect(resolved).toEqual({ ...fallback, language: "kotlin" });
  });

  it("carries exactly the requested languages", () => {
    const resolved = resolveLanguageCapabilities(["typescript", "sql"]);
    expect([...resolved.keys()]).toEqual(["typescript", "sql"]);
  });
});
