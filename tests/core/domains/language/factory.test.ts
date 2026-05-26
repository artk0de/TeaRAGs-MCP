import { describe, expect, it } from "vitest";

import { LanguageFactoryImpl } from "../../../../src/core/domains/language/factory.js";
import { UnsupportedLanguageError } from "../../../../src/core/domains/language/errors.js";

/**
 * The factory is a SKELETON during the consolidation (spec migration step 1):
 * no per-language verticals are wired yet, so `supported()` is empty and
 * `create()` rejects every language with a typed `UnsupportedLanguageError`.
 * Per-language verticals (step 2) populate the registration map; these
 * assertions then change to expect real providers.
 */
describe("LanguageFactoryImpl (skeleton)", () => {
  const factory = new LanguageFactoryImpl();

  it("supported() is empty — no verticals registered yet", () => {
    expect(factory.supported()).toEqual([]);
  });

  it("create() throws a typed UnsupportedLanguageError for any language", () => {
    expect(() => factory.create("ruby")).toThrow(UnsupportedLanguageError);
    expect(() => factory.create("typescript")).toThrow(UnsupportedLanguageError);
  });

  it("the thrown error names the requested language", () => {
    expect(() => factory.create("python")).toThrow(/python/);
  });
});
