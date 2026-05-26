import { buildLegacyLanguageRegistry } from "../../../../../../src/core/api/internal/legacy-language-adapter.js";
import type { CallResolver } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactory } from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactoryImpl } from "../../../../../../src/core/domains/language/index.js";

/**
 * Build a `LanguageFactory` for codegraph provider tests from a resolver map.
 * Reuses the production composition-root hybrid adapter
 * (`buildLegacyLanguageRegistry`) so the walker capability the provider reads is
 * the SAME `CODEGRAPH_LANGUAGES` walk/nameOf, and the resolver capability wraps
 * the exact resolvers the test supplied.
 */
export function languageFactoryFor(resolvers: Map<string, CallResolver>): LanguageFactory {
  return new LanguageFactoryImpl(buildLegacyLanguageRegistry(resolvers));
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
