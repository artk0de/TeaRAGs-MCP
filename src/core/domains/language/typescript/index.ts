/**
 * `TypeScriptLanguage` — the native per-language facade for TypeScript, the
 * second vertical migrated off the composition-root legacy adapter into
 * `domains/language/` (spec §2, §4; bd tea-rags-mcp-cen6, following the ruby
 * pilot). Thin: it composes the four capability sub-modules, all of which are
 * pure module-level logic + config that any instance merely references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator ".", detection)
 *   chunkerHooks  ← ./chunking/            (test-dsl filter/scope, comment-capture, class-body)
 *   walker        ← ./walker/              (extractFromTypescriptFile + tsNameOf)
 *   resolver      ← ./resolver/            (TSCallResolver — tsconfig path mapping)
 *
 * Created per-context by `LanguageFactoryDescriptor` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build, plus the
 * resolver's one-time `loadTsConfig` — deferred to the first resolve, because
 * only then is the root of the project being indexed known.
 *
 * Two grammars, one provider: `.ts` and `.tsx` both map to language "typescript"
 * (`LANGUAGE_MAP`). The CHUNKER uses the kernel's `.typescript` grammar for both
 * (`kernel.ts` note). The CODEGRAPH engine loads the `.tsx` grammar for `.tsx`
 * files via the retained `CODEGRAPH_LANGUAGES[".tsx"].loadParser` — both reach
 * the SAME `walker.walk` (`extractFromTypescriptFile`, grammar-agnostic for the
 * node types it reads). So the provider parses both correctly without itself
 * holding two grammars: the per-extension grammar choice stays on the legacy map.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  emptyDispatchFanout,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchFanoutOutcome,
  type FileExtraction,
  type SymbolResolutionPassPlan,
  type SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { typescriptChunkClassifier, typescriptHooks } from "./chunking/index.js";
import { typescriptKernel } from "./kernel.js";
import { loadTsConfig, TSCallResolver } from "./resolver/index.js";
import { tsNameOf } from "./walker/name-of.js";
import { extractFromTypescriptFile, type ExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for TypeScript — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.typescript` entry 1:1 (chunkableTypes, childChunkTypes,
 * alwaysExtractChildren, and the ordered hook chain). No `nameExtractor` /
 * `keepShortChildChunkTypes` / `macroSymbols` — TypeScript declares none (it has
 * no `def`-less method idiom, unlike Ruby's class-body DSL macros).
 */
const typescriptChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    // tree-sitter-typescript emits `abstract_class_declaration` (NOT
    // `class_declaration`) for `abstract class X {}` — bd tea-rags-mcp-olc2.
    // Without it the abstract container is never recognized, so its methods
    // never become standalone chunks and `find_symbol("Base#foo")` misses
    // the body even though the codegraph layer has the symbol. The codegraph
    // provider already treats both node types alike (symbols/provider.ts).
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "call_expression", // Filtered by testDslFilterHook to DSL calls in test files
    // bd tea-rags-mcp-grz07 — kept ONLY when the declaration binds a
    // MODULE-LEVEL function expression (`export const fn = () => {}`), the
    // dominant declaration shape in React code, which produced no chunk at all
    // before. `typescriptFunctionDeclarationFilterHook` rejects every other
    // declaration so `findChunkableNodes` keeps DESCENDING through it — which is
    // what the const-object namespace (`export const X = { m() {} }`) needs to
    // reach its `method_definition` (bd tea-rags-mcp-62hzr). The symbolId is
    // then composed by `typescriptChunkClassifier`, since a
    // `lexical_declaration` carries no `name` field of its own.
    //
    // Mirrors JavaScript, which has listed both since bd tea-rags-mcp-kfzx.
    "lexical_declaration",
    "variable_declaration",
  ],
  childChunkTypes: ["method_definition", "call_expression"],
  alwaysExtractChildren: true,
  hooks: typescriptHooks,
  classifier: typescriptChunkClassifier,
};

/**
 * Native TypeScript `LanguageProvider`. Construction is cheap and reads nothing
 * from disk: the resolver — and with it `loadTsConfig`, the project file probe
 * and the `ts.Program` — is built on FIRST RESOLVE, against the root that
 * resolve names. The chunker worker never invokes the resolver, so there it is
 * never built at all. `mode` controls ambiguous-resolution behaviour, matching
 * the legacy adapter's `TSCallResolver` default.
 */
export class TypeScriptLanguage implements LanguageProvider {
  readonly kernel = typescriptKernel;
  readonly chunkerHooks: LanguageChunkerHooks = typescriptChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromTypescriptFile(input),
    nameOf: (node) => tsNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  /**
   * The resolver currently bound, with the root it was built for. Single-entry
   * rather than a map: one provider instance serves one indexed project at a
   * time (the same assumption `CodegraphRunState` documents for its own
   * run-global maps), and a `ts.Program` is far too heavy to keep one per root
   * that has ever been seen.
   */
  private bound: { root: string; resolver: CallResolver } | undefined;

  /**
   * @param mode Ambiguous-resolution behaviour, matching the legacy adapter's
   *   `TSCallResolver` default.
   * @param repoRoot FALLBACK root, used only when a resolve arrives with no
   *   `ctx.projectRoot` — direct construction from inside the target repo
   *   (scripts, tests). It is not the codegraph path's root: that one arrives
   *   per run on the call context.
   *
   *   bd tea-rags-mcp-f4wcm made this a constructor parameter and had the
   *   codegraph provider factory fill it with `config.rootDir` — the DuckDB
   *   storage root under `paths.appData`, decided at bootstrap before any
   *   project is bound, and never a repository. Construction is simply too
   *   early to know which project the calls belong to, so the root now comes
   *   from the run.
   */
  constructor(
    private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    private readonly repoRoot: string = process.cwd(),
  ) {
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null =>
        this.resolverFor(ctx).resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchFanoutOutcome =>
        this.resolverFor(ctx).resolveDispatch?.(call, ctx) ?? emptyDispatchFanout(),
      // Forwarded so imports map through `mapImportToFile` rather than through
      // the provider's synthesised-call loop, whose fake `member` a member-keyed
      // pass can answer (bd tea-rags-mcp-5onmn). Mirrors the Ruby adapter.
      resolveFileEdges: (extraction, ctx) => this.resolverFor(ctx).resolveFileEdges?.(extraction, ctx) ?? [],
      targetsExternalImport: (call: CallRef, ctx: CallContext): boolean =>
        this.resolverFor(ctx).targetsExternalImport?.(call, ctx) ?? false,
      // The one entry point that arrives BEFORE any call site, so it carries
      // the run's root itself (bd tea-rags-mcp-6aytq). Binding on it is the
      // point: the whole-project Program it primes must be built against the
      // project pass-2 is about to resolve, not against the fallback root.
      prepareResolvePass: (plan: SymbolResolutionPassPlan): void => {
        this.resolverForRoot(plan.projectRoot ?? this.repoRoot).prepareResolvePass?.(plan);
      },
      // Reported off the BOUND resolver, never a freshly built one: the numbers
      // belong to the cache the run has been resolving through, and binding a
      // new root here would answer with a cache that has done nothing.
      diagnostics: (): Record<string, unknown> | undefined => this.bound?.resolver.diagnostics?.(),
    };
  }

  /**
   * The `TSCallResolver` for the root this call belongs to, built once and
   * reused while the root holds. One root serves both concerns the resolver
   * has: the tsconfig the path mapper reads and the project the typeChecker
   * fallback resolves files against must be the same directory, or a Program
   * gets built from paths the mapper never produces (bd tea-rags-mcp-uclbn).
   */
  private resolverFor(ctx: CallContext): CallResolver {
    return this.resolverForRoot(ctx.projectRoot ?? this.repoRoot);
  }

  /** {@link resolverFor} keyed by the root directly, for callers with no call site. */
  private resolverForRoot(root: string): CallResolver {
    if (this.bound?.root !== root) {
      this.bound = { root, resolver: new TSCallResolver(loadTsConfig(root), this.mode, root) };
    }
    return this.bound.resolver;
  }
}

export { typescriptKernel } from "./kernel.js";
export { typescriptHooks } from "./chunking/index.js";
export { extractFromTypescriptFile, tsNameOf } from "./walker/index.js";
export {
  createProjectFileProbe,
  loadTsConfig,
  mapImportToFile,
  TSCallResolver,
  type ProjectFileProbe,
  type TsCompilerOptions,
} from "./resolver/index.js";
export type { FileExtraction, ExtractInput };
