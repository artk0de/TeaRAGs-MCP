import { buildLegacyLanguageRegistry } from "../../../../../../src/core/api/internal/legacy-language-adapter.js";
import type { CallResolver } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactory } from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactoryImpl, RubyLanguage } from "../../../../../../src/core/domains/language/index.js";

/**
 * Build a `LanguageFactory` for codegraph provider tests from a resolver map.
 * Reuses the production composition-root hybrid adapter
 * (`buildLegacyLanguageRegistry`) so the walker capability the provider reads is
 * the SAME `CODEGRAPH_LANGUAGES` walk/nameOf for not-yet-migrated languages, and
 * the resolver capability wraps the exact resolvers the test supplied. Migrated
 * languages (ruby — tea-rags-mcp-cen6) are wired natively over the top, exactly
 * as the production composition roots do (composition.ts / chunker-worker.ts):
 * the adapter skips them via NATIVE_LANGUAGES.
 */
export function languageFactoryFor(resolvers: Map<string, CallResolver>): LanguageFactory {
  const registry = buildLegacyLanguageRegistry(resolvers);
  // Native ruby provider carries its own walker + resolver (uses the resolver
  // mode default); the adapter no longer serves ruby.
  registry.set("ruby", new RubyLanguage());
  return new LanguageFactoryImpl(registry);
}

/**
 * Spread helper for `CodegraphEnrichmentProvider` / `createSymbolsTrajectory`
 * deps: returns both `resolvers` (kept on the deps type) and the matching
 * `languageFactory` the provider now reads, so a single `...buildTestCodegraphDeps(map)`
 * replaces a bare `resolvers: map` at every construction site.
 */
export function buildTestCodegraphDeps(resolvers: Map<string, CallResolver>): {
  resolvers: Map<string, CallResolver>;
  languageFactory: LanguageFactory;
} {
  return { resolvers, languageFactory: languageFactoryFor(resolvers) };
}
