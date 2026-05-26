import { describe, expect, it } from "vitest";

import type { CallResolver } from "../../../../src/core/contracts/types/codegraph.js";
import {
  NATIVE_LANGUAGES,
  buildLegacyLanguageRegistry,
} from "../../../../src/core/api/internal/legacy-language-adapter.js";
import { LanguageFactoryImpl } from "../../../../src/core/domains/language/index.js";
import {
  LANGUAGE_DEFINITIONS,
} from "../../../../src/core/domains/ingest/pipeline/chunker/config.js";
import { CODEGRAPH_LANGUAGES } from "../../../../src/core/domains/trajectory/codegraph/index.js";
import { classifyMethod } from "../../../../src/core/infra/symbolid/index.js";
import { UnsupportedLanguageError } from "../../../../src/core/domains/language/errors.js";

/**
 * Adapter-fidelity tests (bd tea-rags-mcp-cat4 commit 1). Prove the
 * composition-root hybrid wraps the EXISTING per-language sources into
 * `LanguageProvider`s WITHOUT any behavioural drift — every field the chunker /
 * codegraph engines read today is reproduced identically through the factory.
 *
 * Languages migrated to a native `domains/language/<lang>` provider are SKIPPED
 * by the adapter (`NATIVE_LANGUAGES`, e.g. ruby — tea-rags-mcp-cen6); the
 * composition roots wire those natively over the top. So the adapter-served set
 * is `LANGUAGE_DEFINITIONS` minus `NATIVE_LANGUAGES`, and the fidelity loops only
 * cover adapter-served languages.
 */
describe("legacyLanguageRegistry adapter fidelity", () => {
  // Reverse-index codegraph configs by language name (the registry key) so a
  // multi-extension language resolves to its single shared walker config.
  const codegraphByLang = new Map<string, (typeof CODEGRAPH_LANGUAGES)[string]>();
  for (const cfg of Object.values(CODEGRAPH_LANGUAGES)) {
    if (!codegraphByLang.has(cfg.language)) codegraphByLang.set(cfg.language, cfg);
  }

  // Languages the legacy adapter actually wraps (native ones are skipped).
  const adapterServedLangs = Object.keys(LANGUAGE_DEFINITIONS).filter(
    (lang) => !NATIVE_LANGUAGES.has(lang),
  );
  const adapterServedCodegraphLangs = [...codegraphByLang.keys()].filter(
    (lang) => !NATIVE_LANGUAGES.has(lang),
  );

  it("registers exactly the adapter-served languages (LANGUAGE_DEFINITIONS minus native)", () => {
    const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
    expect(new Set(factory.supported())).toEqual(new Set(adapterServedLangs));
  });

  it.each(adapterServedLangs)(
    "chunkerHooks for %s match LANGUAGE_DEFINITIONS verbatim",
    (lang) => {
      const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
      const def = LANGUAGE_DEFINITIONS[lang];
      const hooks = factory.create(lang).chunkerHooks;
      expect(hooks).toBeDefined();
      expect(hooks?.chunkableTypes).toBe(def.chunkableTypes);
      expect(hooks?.childChunkTypes).toBe(def.childChunkTypes);
      expect(hooks?.alwaysExtractChildren).toBe(def.alwaysExtractChildren);
      expect(hooks?.isDocumentation).toBe(def.isDocumentation);
      expect(hooks?.hooks).toBe(def.hooks);
      expect(hooks?.nameExtractor).toBe(def.nameExtractor);
      expect(hooks?.keepShortChildChunkTypes).toBe(def.keepShortChildChunkTypes);
    },
  );

  it.each(adapterServedLangs)(
    "kernel for %s mirrors LANGUAGE_DEFINITIONS parser-load + namespace config",
    (lang) => {
      const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
      const def = LANGUAGE_DEFINITIONS[lang];
      const { kernel } = factory.create(lang);
      expect(kernel.loadModule).toBe(def.loadModule);
      expect(kernel.extractLanguage).toBe(def.extractLanguage);
      expect(kernel.scopeSeparator).toBe(def.scopeSeparator);
      expect(kernel.scopeContainerTypes).toBe(def.scopeContainerTypes);
      expect(kernel.disambiguateOverloads).toBe(def.disambiguateOverloads);
    },
  );

  it("isInstanceMethod is classifyMethod(node) === 'instance' (false for non-method nodes)", () => {
    const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
    const { isInstanceMethod } = factory.create("typescript").kernel;
    // Instance method (TS method_definition, no `static`).
    const instanceNode = { type: "method_definition", children: [], text: "" } as never;
    expect(isInstanceMethod(instanceNode)).toBe(true);
    expect(classifyMethod(instanceNode)).toBe("instance");
    // Static method.
    const staticNode = {
      type: "method_definition",
      children: [{ type: "static", text: "static" }],
      text: "static foo(){}",
    } as never;
    expect(isInstanceMethod(staticNode)).toBe(false);
    // Non-method node must be false (NOT !isStaticMethodNode → would be true).
    const classNode = { type: "class_declaration", children: [], text: "" } as never;
    expect(isInstanceMethod(classNode)).toBe(false);
    expect(classifyMethod(classNode)).toBeNull();
  });

  it.each(adapterServedCodegraphLangs)(
    "walker for %s reuses CODEGRAPH_LANGUAGES walk + nameOf",
    (lang) => {
      const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
      const cfg = codegraphByLang.get(lang)!;
      const { walker } = factory.create(lang);
      expect(walker).toBeDefined();
      expect(walker?.walk).toBe(cfg.walker);
      expect(walker?.nameOf).toBe(cfg.nameOf);
      // kernel scopeSeparator / disambiguateOverloads must equal the codegraph
      // map's values so the provider switch (commit 3) is behaviour-preserving.
      // The codegraph map defaults scopeSeparator to a concrete string; the
      // chunker map leaves "." implicit (undefined). Both resolve to the same
      // effective separator.
      const { kernel } = factory.create(lang);
      expect(kernel.scopeSeparator ?? ".").toBe(cfg.scopeSeparator);
      expect(kernel.disambiguateOverloads ?? false).toBe(cfg.disambiguateOverloads ?? false);
    },
  );

  it("markdown (doc language) has chunkerHooks but no walker and no resolver", () => {
    const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
    const md = factory.create("markdown");
    expect(md.chunkerHooks).toBeDefined();
    expect(md.chunkerHooks?.isDocumentation).toBe(true);
    expect(md.walker).toBeUndefined();
    expect(md.resolver).toBeUndefined();
  });

  it("wraps a CallResolver into a LanguageSymbolResolver with resolveDispatch default", () => {
    const calls: string[] = [];
    const fakeResolver: CallResolver = {
      language: "typescript",
      resolve: () => {
        calls.push("resolve");
        return null;
      },
      // No resolveDispatch — the wrapper must default to [].
    };
    const registry = buildLegacyLanguageRegistry(new Map([["typescript", fakeResolver]]));
    const factory = new LanguageFactoryImpl(registry);
    const { resolver } = factory.create("typescript");
    expect(resolver).toBeDefined();
    const call = { callText: "x()", receiver: null, member: "x", startLine: 1 } as never;
    const ctx = {} as never;
    expect(resolver?.resolve(call, ctx)).toBeNull();
    expect(calls).toEqual(["resolve"]);
    expect(resolver?.resolveDispatch(call, ctx)).toEqual([]);
  });

  it("delegates resolveDispatch when the CallResolver supports it", () => {
    const edge = { sourceSymbolId: null, targetSymbolId: "Foo#bar", targetFile: "foo.ts" };
    const fakeResolver: CallResolver = {
      language: "typescript",
      resolve: () => null,
      resolveDispatch: () => [edge as never],
    };
    const registry = buildLegacyLanguageRegistry(new Map([["typescript", fakeResolver]]));
    const { resolver } = new LanguageFactoryImpl(registry).create("typescript");
    expect(resolver?.resolveDispatch({} as never, {} as never)).toEqual([edge]);
  });

  it("create() throws UnsupportedLanguageError for an unregistered language", () => {
    const factory = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
    expect(() => factory.create("cobol")).toThrow(UnsupportedLanguageError);
  });

  it("builds resolver only when codegraph resolvers are supplied", () => {
    const noResolvers = new LanguageFactoryImpl(buildLegacyLanguageRegistry());
    expect(noResolvers.create("typescript").resolver).toBeUndefined();
  });
});
