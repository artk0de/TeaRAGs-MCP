import type { AmbiguousResolveMode } from "../../contracts/types/codegraph.js";
import { DEFAULT_AMBIGUOUS_RESOLVE_MODE } from "../../contracts/types/codegraph.js";
import type { LanguageFactory, LanguageProvider } from "../../contracts/types/language.js";
import { UnsupportedLanguageError } from "./errors.js";
import { JavaScriptLanguage } from "./javascript/index.js";
import { PythonLanguage } from "./python/index.js";
import { RubyLanguage } from "./ruby/index.js";
import { TypeScriptLanguage } from "./typescript/index.js";

/**
 * A deferred per-language provider builder. The composition layer
 * (`api/internal/legacy-language-adapter.ts`) holds the legacy per-language
 * config (the chunker `LANGUAGE_DEFINITIONS`, the codegraph `CODEGRAPH_LANGUAGES`
 * map + resolver map) — sources the leaf `domains/language` domain may NOT import
 * (domain-boundaries.md). It hands the factory a *thunk* per non-native language
 * instead of a pre-built provider, so the factory — not the caller — decides WHEN
 * the provider is constructed (lazily, on first `create(lang)`) and caches it.
 */
export type LegacyProviderBuilder = () => LanguageProvider;

/**
 * Languages the factory builds NATIVELY from a `domains/language/<lang>`
 * provider rather than from an injected legacy thunk. The factory owns the
 * construction (`new RubyLanguage(mode)`) so the native switch lives in ONE
 * place — `create(lang)` — not at every composition root. Mirrors
 * `NATIVE_LANGUAGES` in the legacy adapter (which skips these) and
 * `NATIVE_CHUNKER_LANGUAGES` in the ingest-local registry. bd tea-rags-mcp-cen6.
 */
const NATIVE_LANGUAGES: ReadonlySet<string> = new Set<string>(["ruby", "typescript", "javascript", "python"]);

/**
 * Real `LanguageFactory`. `create(lang)` ENCAPSULATES construction — it builds
 * the `LanguageProvider` itself rather than reading one from a consumer-assembled
 * registry:
 *
 *   - **Native** languages (`ruby`, …) → the factory constructs the native
 *     `domains/language/<lang>` provider directly (`new RubyLanguage(mode)`),
 *     applying the configured ambiguous-resolve `mode`.
 *   - **Legacy** languages → the factory invokes the deferred builder thunk the
 *     composition layer injected (built from `LANGUAGE_DEFINITIONS` /
 *     `CODEGRAPH_LANGUAGES` in `api/internal/`, the only layer allowed to bridge
 *     ingest + trajectory + language).
 *
 * Each built provider is cached per language (spec §5: `create` is expensive —
 * it loads the grammar / builds a Parser — so callers MUST cache; the factory
 * caches internally too, so repeat `create(lang)` is a map lookup). A native
 * provider and a legacy thunk are NEVER both registered for the same language:
 * the legacy adapter skips `NATIVE_LANGUAGES`, so the thunk map and the native
 * set are disjoint by construction.
 */
export class LanguageFactoryImpl implements LanguageFactory {
  private readonly legacyBuilders: ReadonlyMap<string, LegacyProviderBuilder>;
  /**
   * Shared native ambiguous-resolve mode. Threaded into EVERY native provider's
   * resolver (`RubyLanguage`, `TypeScriptLanguage`, …) so they stay
   * behaviour-identical to the legacy resolver-map entries the adapter built
   * with the same mode. Not ruby-specific — generalised when the typescript
   * vertical landed (bd tea-rags-mcp-cen6).
   */
  private readonly ambiguousResolveMode: AmbiguousResolveMode;
  private readonly cache = new Map<string, LanguageProvider>();

  /**
   * @param legacyBuilders Deferred provider builders for the non-native
   *   languages, keyed by language NAME. Accepts a `Map` or a plain `Record`.
   * @param options.ambiguousResolveMode Threaded into native resolvers
   *   (`RubyLanguage`, `TypeScriptLanguage`, …) so they stay behaviour-identical
   *   to the legacy resolver-map entry. Defaults to the codegraph default
   *   (`strict`).
   */
  constructor(
    legacyBuilders:
      | ReadonlyMap<string, LegacyProviderBuilder>
      | Record<string, LegacyProviderBuilder> = new Map(),
    options: { ambiguousResolveMode?: AmbiguousResolveMode } = {},
  ) {
    this.legacyBuilders =
      legacyBuilders instanceof Map ? legacyBuilders : new Map(Object.entries(legacyBuilders));
    this.ambiguousResolveMode = options.ambiguousResolveMode ?? DEFAULT_AMBIGUOUS_RESOLVE_MODE;
  }

  create(lang: string): LanguageProvider {
    const cached = this.cache.get(lang);
    if (cached) return cached;

    const provider = this.build(lang);
    this.cache.set(lang, provider);
    return provider;
  }

  /** Construct (never cache) — `create` owns the cache. */
  private build(lang: string): LanguageProvider {
    if (NATIVE_LANGUAGES.has(lang)) {
      // Native switch — extend with one branch per migrated vertical.
      if (lang === "ruby") return new RubyLanguage(this.ambiguousResolveMode);
      if (lang === "typescript") return new TypeScriptLanguage(this.ambiguousResolveMode);
      if (lang === "javascript") return new JavaScriptLanguage(this.ambiguousResolveMode);
      if (lang === "python") return new PythonLanguage(this.ambiguousResolveMode);
    }
    const builder = this.legacyBuilders.get(lang);
    if (builder) return builder();
    throw new UnsupportedLanguageError(lang);
  }

  supported(): string[] {
    return [...new Set([...this.legacyBuilders.keys(), ...NATIVE_LANGUAGES])];
  }
}
