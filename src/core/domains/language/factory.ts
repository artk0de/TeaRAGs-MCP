import type { LanguageFactory, LanguageProvider } from "../../contracts/types/language.js";
import { UnsupportedLanguageError } from "./errors.js";

/**
 * Real `LanguageFactory` backed by a pre-built registry of
 * `LanguageProvider`s keyed by language NAME (`typescript`, `ruby`, …).
 *
 * The registry is assembled by the composition layer (`api/internal/` /
 * `bootstrap/`). During the consolidation it is built by `legacyLanguageRegistry`
 * (the composition-root hybrid, spec §5) which wraps the EXISTING per-language
 * sources (`LANGUAGE_DEFINITIONS`, the codegraph `LANGUAGES` map, the resolver
 * map) into `LanguageProvider`s — no code is relocated yet. Per-language
 * verticals later swap each adapter-backed entry for a native
 * `domains/language/<lang>` provider.
 *
 * `create(lang)` returns the registered provider or throws
 * `UnsupportedLanguageError`. The registry is built ONCE per process (each
 * provider owns its own state), so `create` is a cheap map lookup — callers may
 * still cache per language per the contract (spec §5) but the cost is bounded.
 */
export class LanguageFactoryImpl implements LanguageFactory {
  private readonly registry: ReadonlyMap<string, LanguageProvider>;

  constructor(registry: ReadonlyMap<string, LanguageProvider> | Record<string, LanguageProvider>) {
    this.registry = registry instanceof Map ? registry : new Map(Object.entries(registry));
  }

  create(lang: string): LanguageProvider {
    const provider = this.registry.get(lang);
    if (!provider) throw new UnsupportedLanguageError(lang);
    return provider;
  }

  supported(): string[] {
    return [...this.registry.keys()];
  }
}
