// Leaf domain: per-language code (chunking hooks, walker passes, resolver
// components) behind a single facade family. Consumers (ingest chunker,
// codegraph provider) reach capabilities through the contracts/ interface +
// injected LanguageFactory / SymbolIdComposer — they MUST NOT import this
// domain directly (only api/ composition + the chunker worker root in
// api/internal/ may). See
// docs/superpowers/specs/2026-05-25-domains-language-consolidation-design.md §2.
//
// Component interfaces (ResolverComponent, DispatchResolverComponent,
// ExtractionPass, WalkContext, SymbolIdComposer) live in
// contracts/types/language.ts, not here.
export { resolveViaChain } from "./resolver-chain.js";
export { DefaultSymbolIdComposer } from "./kernel/symbol-id.js";
export { LanguageFactoryImpl } from "./factory.js";
export { LanguageError, UnsupportedLanguageError } from "./errors.js";
export { RubyLanguage } from "./ruby/index.js";
export { TypeScriptLanguage } from "./typescript/index.js";
export { MarkdownLanguage } from "./markdown/index.js";
