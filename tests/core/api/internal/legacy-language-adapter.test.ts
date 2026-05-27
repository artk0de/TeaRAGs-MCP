import { describe, expect, it } from "vitest";

import type { CallResolver } from "../../../../src/core/contracts/types/codegraph.js";
import type { LanguageProvider } from "../../../../src/core/contracts/types/language.js";
import {
  NATIVE_LANGUAGES,
  buildLegacyLanguageRegistry,
} from "../../../../src/core/api/internal/legacy-language-adapter.js";
import { LanguageFactoryImpl } from "../../../../src/core/domains/language/index.js";
import {
  LANGUAGE_DEFINITIONS,
} from "../../../../src/core/domains/ingest/pipeline/chunker/config.js";
import { UnsupportedLanguageError } from "../../../../src/core/domains/language/errors.js";

/**
 * Adapter-fidelity tests (bd tea-rags-mcp-cat4 commit 1). Originally proved the
 * composition-root hybrid wraps the EXISTING per-language sources into
 * `LanguageProvider`s without behavioural drift.
 *
 * After the markdown vertical landed (tea-rags-mcp-cen6, the FINAL vertical),
 * EVERY language is native (`NATIVE_LANGUAGES`: ruby + typescript + javascript +
 * python + go + java + rust + bash + markdown), so the adapter SKIPS them all:
 * `buildLegacyLanguageRegistry()` now returns an EMPTY map. There is no real
 * legacy language left for the fidelity loops to cover.
 *
 * The adapter MACHINERY (thunk assembly, kernel/walker/resolver wrapping,
 * native-skip) still ships until tea-rags-mcp-jh40 deletes it, so these tests
 * keep it covered with a SYNTHETIC in-test stub thunk registered directly into a
 * `LanguageFactoryImpl` under a fake language key (`fixturelang`). Markdown's own
 * doc-only assertions move to the NATIVE factory path (it resolves to
 * `MarkdownLanguage`, NOT through the adapter).
 */
describe("legacyLanguageRegistry adapter fidelity", () => {
  it("returns an EMPTY builder map — every language is now native (adapter vestigial)", () => {
    // The adapter skips all of NATIVE_LANGUAGES; after markdown migrated, that is
    // every entry in LANGUAGE_DEFINITIONS. So the thunk map is empty.
    expect(buildLegacyLanguageRegistry().size).toBe(0);
    const adapterServedLangs = Object.keys(LANGUAGE_DEFINITIONS).filter(
      (lang) => !NATIVE_LANGUAGES.has(lang),
    );
    expect(adapterServedLangs).toEqual([]);
    // The factory still reports the native set via its own switch.
    const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
    expect(new Set(factory.supported())).toEqual(new Set([...NATIVE_LANGUAGES]));
  });

  it("markdown resolves through the NATIVE factory path — doc-only (chunkerHooks, no walker/resolver)", () => {
    // markdown is no longer adapter-served; the factory builds the native
    // `MarkdownLanguage` itself. The doc-only shape is unchanged: chunkerHooks
    // present with isDocumentation, no walker, no resolver.
    const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
    const md = factory.create("markdown");
    expect(md.chunkerHooks).toBeDefined();
    expect(md.chunkerHooks?.isDocumentation).toBe(true);
    expect(md.walker).toBeUndefined();
    expect(md.resolver).toBeUndefined();
  });

  it("a synthetic legacy thunk is built lazily by the factory (machinery still works)", () => {
    // No REAL legacy language remains, so we register a synthetic non-native
    // thunk directly to exercise the deferred-builder mechanism the adapter
    // assembles. `fixturelang` is not in NATIVE_LANGUAGES → the factory invokes
    // the thunk instead of the native switch.
    const stubProvider: LanguageProvider = {
      kernel: { loadModule: async () => null, isInstanceMethod: () => false },
      chunkerHooks: { chunkableTypes: ["function"] },
    };
    const factory = new LanguageFactoryImpl(new Map([["fixturelang", () => stubProvider]]));
    expect(factory.create("fixturelang")).toBe(stubProvider);
    expect(factory.create("fixturelang").chunkerHooks?.chunkableTypes).toEqual(["function"]);
  });

  it("wraps a CallResolver-style resolver into a LanguageSymbolResolver with resolveDispatch default", () => {
    // The adapter's resolver-wrapping shape is language-agnostic. No real legacy
    // language exercises it anymore, so we mirror the wrapper inline behind a
    // synthetic thunk: a resolver WITHOUT resolveDispatch must default to [].
    const calls: string[] = [];
    const fakeResolver: CallResolver = {
      language: "fixturelang",
      resolve: () => {
        calls.push("resolve");
        return null;
      },
      // No resolveDispatch — the wrapper must default to [].
    };
    const stubProvider: LanguageProvider = {
      kernel: { loadModule: async () => null, isInstanceMethod: () => false },
      resolver: {
        resolve: (call, ctx) => fakeResolver.resolve(call, ctx),
        resolveDispatch: (call, ctx) => fakeResolver.resolveDispatch?.(call, ctx) ?? [],
      },
    };
    const factory = new LanguageFactoryImpl(new Map([["fixturelang", () => stubProvider]]));
    const { resolver } = factory.create("fixturelang");
    expect(resolver).toBeDefined();
    const call = { callText: "x()", receiver: null, member: "x", startLine: 1 } as never;
    const ctx = {} as never;
    expect(resolver?.resolve(call, ctx)).toBeNull();
    expect(calls).toEqual(["resolve"]);
    expect(resolver?.resolveDispatch(call, ctx)).toEqual([]);
  });

  it("delegates resolveDispatch when the underlying resolver supports it", () => {
    const edge = { sourceSymbolId: null, targetSymbolId: "foo", targetFile: "lib.md" };
    const fakeResolver: CallResolver = {
      language: "fixturelang",
      resolve: () => null,
      resolveDispatch: () => [edge as never],
    };
    const stubProvider: LanguageProvider = {
      kernel: { loadModule: async () => null, isInstanceMethod: () => false },
      resolver: {
        resolve: (call, ctx) => fakeResolver.resolve(call, ctx),
        resolveDispatch: (call, ctx) => fakeResolver.resolveDispatch?.(call, ctx) ?? [],
      },
    };
    const { resolver } = new LanguageFactoryImpl(
      new Map([["fixturelang", () => stubProvider]]),
    ).create("fixturelang");
    expect(resolver?.resolveDispatch({} as never, {} as never)).toEqual([edge]);
  });

  it("create() throws UnsupportedLanguageError for an unregistered language", () => {
    const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
    expect(() => factory.create("cobol")).toThrow(UnsupportedLanguageError);
  });
});
