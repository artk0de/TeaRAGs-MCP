import { describe, expect, it } from "vitest";

import type { LanguageProvider } from "../../../../src/core/contracts/types/language.js";
import { LanguageFactoryImpl } from "../../../../src/core/domains/language/factory.js";
import { UnsupportedLanguageError } from "../../../../src/core/domains/language/errors.js";

/**
 * The factory is now REAL (consolidation migration step 1, bd tea-rags-mcp-cat4):
 * it takes a registry of `LanguageProvider`s keyed by language name and resolves
 * `create(lang)` against it. The composition layer builds the registry via the
 * legacy adapter (see `legacy-language-adapter.test.ts` for the adapter
 * fidelity); these tests cover the factory's own contract with a minimal stub
 * registry, independent of the adapter.
 */
describe("LanguageFactoryImpl", () => {
  const stubProvider: LanguageProvider = {
    kernel: { loadModule: async () => null, isInstanceMethod: () => false },
  };

  it("supported() reflects the registry keys (empty when none registered)", () => {
    expect(new LanguageFactoryImpl(new Map()).supported()).toEqual([]);
    const factory = new LanguageFactoryImpl(new Map([["ruby", stubProvider]]));
    expect(factory.supported()).toEqual(["ruby"]);
  });

  it("create() returns the registered provider", () => {
    const factory = new LanguageFactoryImpl({ ruby: stubProvider });
    expect(factory.create("ruby")).toBe(stubProvider);
  });

  it("accepts both a ReadonlyMap and a Record registry", () => {
    expect(new LanguageFactoryImpl(new Map([["ts", stubProvider]])).create("ts")).toBe(stubProvider);
    expect(new LanguageFactoryImpl({ ts: stubProvider }).create("ts")).toBe(stubProvider);
  });

  it("create() throws a typed UnsupportedLanguageError for an unregistered language", () => {
    const factory = new LanguageFactoryImpl(new Map([["ruby", stubProvider]]));
    expect(() => factory.create("typescript")).toThrow(UnsupportedLanguageError);
  });

  it("the thrown error names the requested language", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(() => factory.create("python")).toThrow(/python/);
  });
});
