/**
 * Composition-root hybrid (spec §5): wraps the EXISTING per-language sources
 * into `LanguageProvider`s WITHOUT relocating any code yet. This module is the
 * ONE place allowed to import BOTH the leaf `domains/language` consumer surface
 * (via the `contracts/` interfaces) AND the old per-language maps that still
 * live in `domains/ingest` (the chunker `LANGUAGE_DEFINITIONS`) and
 * `domains/trajectory` (the codegraph `CODEGRAPH_LANGUAGES` map + resolver map).
 *
 * It lives in `api/internal/` — the composition layer — because the eslint
 * leaf-domain guards forbid `domains/language` from importing ingest/trajectory
 * AND forbid ingest/trajectory from importing `domains/language`. Only `api/`
 * and `bootstrap/` may bridge the two. See `.claude/rules/domain-boundaries.md`
 * + spec §2/§5. bd tea-rags-mcp-cat4.
 *
 * Per-language verticals later swap each adapter-backed entry for a native
 * `domains/language/<lang>` provider; this adapter is deleted by the cleanup
 * task (tea-rags-mcp-jh40) once every language has moved.
 *
 * Languages already migrated to a native `domains/language/<lang>` provider are
 * listed in `NATIVE_LANGUAGES` and SKIPPED here — the composition roots wire
 * their native provider into the registry instead. Ruby is the first
 * (tea-rags-mcp-cen6, the richest-first pilot). Skipping is what lets the old
 * per-language sources be deleted: this adapter no longer references them.
 */

import type { CallResolver } from "../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageKernel,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../contracts/types/language.js";
import {
  LANGUAGE_DEFINITIONS,
  type LanguageDefinition,
} from "../../domains/ingest/pipeline/chunker/config.js";
import { classifyMethod } from "../../infra/symbolid/index.js";
import {
  CODEGRAPH_LANGUAGES,
  type CodegraphLanguageConfig,
} from "../../domains/trajectory/codegraph/index.js";

/**
 * Build the chunker-side capability from a legacy `LanguageDefinition`. Mirrors
 * the field set the chunker reads from `LANGUAGE_DEFINITIONS[lang]` 1:1 — no
 * transformation, no defaults applied here (the chunker still applies its own
 * defaults downstream).
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
 * Build the per-language `kernel` — parser loading + the cross-engine detection
 * + namespace config shared by chunker and walker. `isInstanceMethod` is
 * derived from the existing `classifyMethod` (infra/symbolid): a node is an
 * instance method iff `classifyMethod(node) === "instance"`. Using
 * `classifyMethod` (not `!isStaticMethodNode`) preserves the interface contract
 * that NON-method nodes return `false` (classifyMethod yields `null` → not
 * "instance" → false), behaviour-identical to the per-engine static checks that
 * only ever ask about method nodes.
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
 * Build the codegraph `walker` capability from the legacy `CODEGRAPH_LANGUAGES`
 * config (keyed by extension). The `LanguageWalker` interface exposes only
 * `walk` + `nameOf`; the parser-load / scopeSeparator / disambiguateOverloads
 * bits that the provider also reads from its map are carried by the kernel
 * instead (and are numerically equal — verified in the fidelity test).
 *
 * Returns `undefined` when the config carries no `walker` (`cfg.walker` is
 * OPTIONAL — a language migrated to a native `domains/language/<lang>` provider
 * drops its walker from the legacy map). A missing walker means the language
 * legitimately has no codegraph-extraction capability, so the provider's
 * `walker` is `undefined` — NOT a `LanguageWalker` whose `walk` returns
 * undefined. The `nameOf` companion is meaningless without `walk`, so both are
 * dropped together.
 */
function walkerFrom(cfg: CodegraphLanguageConfig): LanguageWalker | undefined {
  // `walker` AND `nameOf` are both OPTIONAL on the config (a native-migrated
  // language drops both together — a `nameOf` without `walk` is meaningless, and
  // vice versa). The adapter only wraps a NON-native language here, which always
  // carries both, so requiring both is the correct gate: a missing either means
  // no codegraph-extraction capability for this entry.
  if (!cfg.walker || !cfg.nameOf) return undefined;
  return {
    walk: cfg.walker,
    nameOf: cfg.nameOf,
  };
}

/**
 * Wrap a legacy `CallResolver` into the language-domain `LanguageSymbolResolver`
 * facade. `resolveDispatch` is optional on `CallResolver` (resolvers that don't
 * support lookup-table dispatch omit it) but non-optional on
 * `LanguageSymbolResolver` (returns `[]`), so the wrapper supplies the `[]`
 * default — behaviour-identical to the provider's existing `resolver.resolveDispatch?.(...)
 * ?? []` guard.
 */
function resolverFrom(resolver: CallResolver): LanguageSymbolResolver {
  return {
    resolve: (call, ctx) => resolver.resolve(call, ctx),
    resolveDispatch: (call, ctx) => resolver.resolveDispatch?.(call, ctx) ?? [],
  };
}

/**
 * Languages served by a native `domains/language/<lang>` provider rather than
 * this legacy adapter. Each is wired into the registry by the composition roots
 * (`composition.ts` + `chunker-worker.ts`). The adapter skips them so the old
 * per-language sources can be deleted without leaving a dangling reference here.
 */
export const NATIVE_LANGUAGES: ReadonlySet<string> = new Set<string>([
  "ruby",
  "typescript",
  "javascript",
  "python",
  "go",
  "java",
]);

/**
 * Assemble the per-language **builder** map (keyed by language NAME) by wrapping
 * every NON-native legacy source in a deferred thunk. `LanguageFactoryImpl`
 * encapsulates construction: it invokes a language's thunk lazily on the first
 * `create(lang)` and caches the result — so the heavy provider object (and its
 * tree-sitter Parser, built downstream) is never constructed until the language
 * is actually processed. Each language in `LANGUAGE_DEFINITIONS` except
 * `NATIVE_LANGUAGES` gets a thunk; the `walker`/`resolver` capabilities are
 * attached only when the matching codegraph config / resolver exists (a doc
 * language like markdown has neither — chunkerHooks only, spec §1a).
 *
 * The thunks captured here close over `LANGUAGE_DEFINITIONS` / `CODEGRAPH_LANGUAGES`
 * — ingest + trajectory sources the leaf `domains/language` domain may not import.
 * Building them in this composition-layer adapter and handing the factory thunks
 * is what lets the factory "build legacy langs from their config" without the
 * factory reaching across domain boundaries (domain-boundaries.md, spec §5).
 *
 * @param resolvers The codegraph resolver map (`CallResolver` per language) —
 *   wired by `bootstrap/factory.ts:wireCodegraph`. Optional: when codegraph is
 *   disabled (no resolvers), every provider is built without a `resolver` and
 *   the registry still serves the chunker.
 */
export function buildLegacyLanguageRegistry(
  resolvers?: ReadonlyMap<string, CallResolver>,
): Map<string, () => LanguageProvider> {
  // Reverse-index the codegraph map (ext -> config) by language name so a
  // language with multiple extensions (typescript: .ts/.tsx; javascript:
  // .js/.jsx/.mjs/.cjs) resolves to the single shared config. The walker is
  // identical across a language's extensions, so the first match wins.
  const codegraphByLang = new Map<string, CodegraphLanguageConfig>();
  for (const cfg of Object.values(CODEGRAPH_LANGUAGES)) {
    if (!codegraphByLang.has(cfg.language)) codegraphByLang.set(cfg.language, cfg);
  }

  const builders = new Map<string, () => LanguageProvider>();
  for (const [lang, def] of Object.entries(LANGUAGE_DEFINITIONS)) {
    if (NATIVE_LANGUAGES.has(lang)) continue; // native provider built by the factory
    const cfg = codegraphByLang.get(lang);
    const callResolver = resolvers?.get(lang);
    builders.set(lang, () => ({
      kernel: kernelFrom(def),
      chunkerHooks: chunkerHooksFrom(def),
      walker: cfg ? walkerFrom(cfg) : undefined,
      resolver: callResolver ? resolverFrom(callResolver) : undefined,
    }));
  }
  return builders;
}
