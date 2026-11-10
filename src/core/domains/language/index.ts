// Leaf domain: per-language code (chunking hooks, walker passes, resolver
// components) behind a single facade family. Consumers (ingest chunker,
// codegraph provider) reach capabilities through the contracts/ interface +
// injected LanguageFactoryDescriptor / SymbolIdComposer — they MUST NOT import this
// domain directly (only api/ composition + the chunker worker root in
// api/internal/ may). See
// docs/superpowers/specs/2026-05-25-domains-language-consolidation-design.md §2.
//
// Component interfaces (SymbolResolutionStrategy, DispatchResolverComponent,
// ExtractionPass, WalkContext, SymbolIdComposer) live in
// contracts/types/language.ts, not here.
export { ConeDispatchResolver, DefaultSymbolIdComposer, collectSymbols, resolveViaChain } from "./kernel/index.js";
export { LanguageFactory } from "./factory.js";
export { CrossRunParseCache } from "./cross-run-parse-cache.js";
export {
  languageIngestIgnoreContribution,
  languageTestFileConventions,
  nativeLanguageCapabilities,
} from "./capability/native.js";
export { renderLanguageCapabilityGuide } from "./capability/rule.js";
export { resolveLanguageCapabilities } from "./capability/resolve.js";
export { resolveChunkSetBumpScopes, resolveLanguageCodeVersions } from "./capability/versions.js";
// Per-language classes (RubyLanguage, TypeScriptLanguage, …) are deliberately
// NOT re-exported here (bd tea-rags-mcp-zkd96): a facade re-export is a static
// import of the whole vertical, which put every facade importer back into the
// resolver-edit `vitest related` closure. Construct providers through
// `LanguageFactory.preload()` + `create()`. `chunkRailsMigration` /
// `foldRailsTableMigrations` stay: the ruby chunking/schema subtrees import no
// resolver code.
export {
  GrammarPackageNotInstalledError,
  LanguageError,
  LanguageModuleNotPreloadedError,
  UnsupportedLanguageError,
} from "./errors.js";
export { providerSources } from "./provider-sources.js";

export { chunkRailsMigration } from "./ruby/chunking/migration-chunker.js";
export { foldRailsTableMigrations } from "./ruby/schema/index.js";
