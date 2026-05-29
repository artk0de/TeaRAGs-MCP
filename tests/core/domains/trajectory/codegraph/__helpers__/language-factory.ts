import type { CallResolver } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";

/**
 * Build a `LanguageFactoryDescriptor` for codegraph provider tests. All languages are
 * native `domains/language/<lang>` providers built by the factory itself — the
 * provider reads each walker (`walk`/`nameOf`) and resolver from
 * `factory.create(lang)`. The legacy adapter / resolver-map wiring was removed
 * by tea-rags-mcp-jh40.
 */
export function languageFactory(): LanguageFactoryDescriptor {
  return new LanguageFactory();
}

/**
 * Spread helper for `CodegraphEnrichmentProvider` / `createSymbolsTrajectory`
 * deps: returns the `languageFactory` the provider reads, so a single
 * `...buildTestCodegraphDeps()` injects it at every construction site.
 *
 * The legacy `resolvers` map is no longer a provider dep (every language is
 * native; its resolver is built by the factory). The optional `resolvers`
 * parameter is accepted and IGNORED so existing call sites that still pass a
 * map keep compiling without churn — the value has no effect on resolution.
 */
export function buildTestCodegraphDeps(_resolvers?: Map<string, CallResolver>): {
  languageFactory: LanguageFactoryDescriptor;
} {
  return { languageFactory: languageFactory() };
}
