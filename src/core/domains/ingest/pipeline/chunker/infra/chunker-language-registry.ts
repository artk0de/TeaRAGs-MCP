/**
 * Chunker-only language registry — the ingest-LOCAL counterpart to the
 * composition-root `buildLegacyLanguageRegistry` (api/internal). The chunker
 * worker thread needs ONLY the chunking capabilities of each language
 * (`chunkerHooks` + `kernel`); it never walks the AST for codegraph or resolves
 * calls. So this builder deliberately does NOT pull in `CODEGRAPH_LANGUAGES`
 * (domains/trajectory) — importing that would (a) drag the DuckDB-backed
 * codegraph stack into the worker bundle and (b) reach into another domain the
 * chunker has no business knowing. Instead each provider is `{ kernel,
 * chunkerHooks }` derived straight from the local `LANGUAGE_DEFINITIONS`;
 * `walker`/`resolver` are left `undefined` (the chunker engine never reads them
 * — see `tree-sitter.ts:getLanguageConfig`, which consults only `chunkerHooks`
 * + `kernel`).
 *
 * Native per-language providers (`RubyLanguage`) are wired in by the worker
 * composition root, NOT here — this builder skips `NATIVE_LANGUAGES` so the
 * native chunker hooks aren't shadowed by the legacy `LANGUAGE_DEFINITIONS`
 * entry retained for `CODE_LANGUAGES`/`LANGUAGE_MAP` reporting.
 *
 * Imports only `contracts/`, `infra/`, and the chunker-local config — fully
 * within `domains/ingest`'s allowed dependency set (domain-boundaries.md). The
 * worker root then layers the native concretes on top.
 */

import type {
  LanguageChunkerHooks,
  LanguageKernel,
  LanguageProvider,
} from "../../../../../contracts/types/language.js";
import { classifyMethod } from "../../../../../infra/symbolid/index.js";
import { LANGUAGE_DEFINITIONS, type LanguageDefinition } from "../config.js";

/**
 * Languages served by a native `domains/language/<lang>` provider, wired into
 * the registry by the worker composition root rather than this builder. Skipped
 * here so the native chunker hooks win over the retained legacy
 * `LANGUAGE_DEFINITIONS` entry. Mirrors `NATIVE_LANGUAGES` in the
 * composition-root adapter (kept local so the worker need not import
 * api/internal).
 */
export const NATIVE_CHUNKER_LANGUAGES: ReadonlySet<string> = new Set<string>([
  "ruby",
  "typescript",
  "javascript",
  "python",
]);

/**
 * Build the chunker-side capability from a legacy `LanguageDefinition` — the
 * chunk-boundary slice the engine reads 1:1 from `LANGUAGE_DEFINITIONS[lang]`.
 */
function chunkerHooksFrom(def: LanguageDefinition): LanguageChunkerHooks {
  return {
    chunkableTypes: def.chunkableTypes,
    childChunkTypes: def.childChunkTypes,
    alwaysExtractChildren: def.alwaysExtractChildren,
    isDocumentation: def.isDocumentation,
    hooks: def.hooks,
    nameExtractor: def.nameExtractor,
    keepShortChildChunkTypes: def.keepShortChildChunkTypes,
  };
}

/**
 * Build the per-language `kernel` — parser loading + namespace config + the
 * instance-method detection the chunker needs for symbolId composition.
 * `isInstanceMethod` derives from the shared `classifyMethod` (infra/symbolid):
 * a node is an instance method iff `classifyMethod(node) === "instance"`,
 * behaviour-identical to the composition-root adapter's `kernelFrom`.
 */
function kernelFrom(def: LanguageDefinition): LanguageKernel {
  return {
    loadModule: def.loadModule,
    extractLanguage: def.extractLanguage,
    scopeSeparator: def.scopeSeparator,
    scopeContainerTypes: def.scopeContainerTypes,
    disambiguateOverloads: def.disambiguateOverloads,
    isInstanceMethod: (node) => classifyMethod(node) === "instance",
  };
}

/**
 * Assemble the chunker-only **builder** map (keyed by language NAME) from
 * `LANGUAGE_DEFINITIONS`, skipping `NATIVE_CHUNKER_LANGUAGES`. Each thunk yields a
 * `{ kernel, chunkerHooks }` provider only — `walker`/`resolver` are `undefined`
 * because the chunker engine never invokes them. Returns deferred thunks (not
 * pre-built providers) to match `LanguageFactoryImpl`'s contract: the factory
 * invokes the thunk lazily on first `create(lang)` and caches. The native
 * languages (`NATIVE_CHUNKER_LANGUAGES`) are built by the factory itself from the
 * dynamically-imported `domains/language` module — never by this builder.
 */
export function buildChunkerLanguageRegistry(): Map<string, () => LanguageProvider> {
  const builders = new Map<string, () => LanguageProvider>();
  for (const [lang, def] of Object.entries(LANGUAGE_DEFINITIONS)) {
    if (NATIVE_CHUNKER_LANGUAGES.has(lang)) continue; // native provider built by the factory
    builders.set(lang, () => ({
      kernel: kernelFrom(def),
      chunkerHooks: chunkerHooksFrom(def),
    }));
  }
  return builders;
}
