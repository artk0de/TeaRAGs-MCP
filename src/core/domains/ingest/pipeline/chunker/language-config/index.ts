/**
 * Chunker language tables as a leaf module: language definitions, the
 * extension map and the detector, importing only `contracts/`.
 *
 * Lives below `chunker/` but owned as a submodule so `pipeline/enrichment/`
 * reads the tables through this barrel instead of deep-importing chunker
 * engine files (bd tea-rags-mcp-g7w8f-2 G4, decision G-D3a). Consumers outside
 * `chunker/` import from here; the engine (`chunker/tree-sitter.ts`) may keep
 * its direct file imports.
 */
export {
  CODE_LANGUAGES,
  DOCUMENTATION_LANGUAGES,
  LANGUAGE_DEFINITIONS,
  LANGUAGE_MAP,
  SELECTABLE_LANGUAGES,
  extensionsForLanguages,
} from "./config.js";
export type { LanguageConfig, LanguageDefinition } from "./config.js";
export { detectLanguage } from "./language-detector.js";
