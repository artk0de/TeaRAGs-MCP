/**
 * `JavaScriptLanguage` — the native per-language facade for JavaScript, the
 * third vertical migrated off the composition-root legacy adapter into
 * `domains/language/` (spec §2, §4; bd tea-rags-mcp-cen6, following ruby +
 * typescript). Thin: it composes the four capability sub-modules, all of which
 * are pure module-level logic + config that any instance merely references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator default ".", detection)
 *   chunkerHooks  ← ./chunking/            (assignment filter + the node-level
 *                                           `chunkSymbols` capability — CommonJS /
 *                                           prototype / dispatch / defineProperty shapes)
 *   walker        ← ./walker/              (extractFromJavascriptFile + jsNameOf)
 *   resolver      ← ./resolver/            (JavascriptCallResolver — relative-import chain)
 *
 * Created per-context by `LanguageFactoryDescriptor` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build.
 *
 * One grammar, four extensions: `.js` / `.jsx` / `.mjs` / `.cjs` all map to
 * language "javascript" (`LANGUAGE_MAP`). Both the CHUNKER and the CODEGRAPH
 * engine use the single `tree-sitter-javascript` grammar (the codegraph
 * `CODEGRAPH_LANGUAGES` entries all share `loadParser: () => JsLang`), so unlike
 * TypeScript there is no per-extension grammar split.
 *
 * symbolId coverage convergence: the chunker emits the CommonJS / pre-class
 * assignment shapes via the `chunkSymbols` capability (engine
 * `tree-sitter.ts:chunkSingleNode`), while the codegraph emits them via
 * `walker.nameOf` (`jsNameOf`). Both MUST stay in lockstep per
 * `.claude/rules/symbolid-convention.md` (bd tea-rags-mcp-kfzx / z95o / d1f8).
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
  type SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { javascriptHooks, JsChunkClassifier, jsExportNameExtractor } from "./chunking/index.js";
import { javascriptKernel } from "./kernel.js";
import { JavascriptCallResolver } from "./resolver/index.js";
import { jsNameOf } from "./walker/name-of.js";
import { extractFromJavascriptFile, type JsExtractInput } from "./walker/walker.js";

/**
 * Chunk-boundary config for JavaScript — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.javascript` entry 1:1 (chunkableTypes + the ordered hook
 * chain), PLUS the node-level `chunkSymbols` capability (the analog of Ruby's
 * `macroSymbols`) the engine reads in `chunkSingleNode`, and the child-descent
 * pair TypeScript has always declared (`childChunkTypes` /
 * `alwaysExtractChildren`) with the `nameExtractor` that descent needs to name
 * an `export_statement` container.
 */
const javascriptChunkerHooks: LanguageChunkerHooks = {
  // `expression_statement` / `lexical_declaration` / `variable_declaration` are
  // kept ONLY when they carry a function value — `jsAssignmentFilterHook` drops
  // the others so we don't chunk `const x = 1` / bare statements with no
  // symbolId. The symbolId is then composed by the classifier (jsChunkSymbols).
  chunkableTypes: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "export_statement",
    "expression_statement",
    "lexical_declaration",
    "variable_declaration",
  ],
  // `method_definition` is a chunkable type above, but `findChunkableNodes`
  // stops descending the moment it claims a node — so a method nested in a
  // container it already claimed (a `class_declaration`, or an object literal
  // inside a `function_declaration` body) was never reached, and the chunker
  // emitted NO chunk for it. cg_symbols still carried the id, leaving
  // `find_symbol("register.handle")` empty while `get_callers` resolved it.
  // TypeScript never had the gap because it declares this pair; JavaScript
  // shares the `method_definition` shape, so it needs the same descent.
  // `call_expression` is deliberately absent — TypeScript lists it only to
  // reach test-DSL calls through `testDslFilterHook`, and JavaScript has
  // neither that hook nor `call_expression` among its chunkable types.
  // bd tea-rags-mcp-ll0u9.
  childChunkTypes: ["method_definition"],
  alwaysExtractChildren: true,
  // `export_statement` is chunkable above, so the engine claims the export
  // rather than the `class_declaration` it wraps — and an export carries no
  // `name` field for the default extraction to find. Without this the descent
  // would scope `Registry`'s method at file level as a bare `register`, an id
  // no cg_symbols row carries. Names ONLY `export_statement`; every other node
  // falls through to the engine's default extraction.
  nameExtractor: jsExportNameExtractor,
  hooks: javascriptHooks,
  // Node→chunk classifier capability — the LanguageChunkClassifier wrapper over
  // jsChunkSymbols (CommonJS `obj.method = fn` / `exports.foo` / `module.exports`,
  // `Foo.prototype.bar`, `const Bar = fn`, the `methods.forEach` HTTP-verb
  // dispatch fan-out, and nested `Object.defineProperty(this, …)` getter installs).
  // symbolIds are ALREADY composed — the engine emits each verbatim at `index + i`,
  // flagged `claimed`.
  classifier: new JsChunkClassifier(),
};

/**
 * Native JavaScript `LanguageProvider`. Construction is cheap — the resolver is
 * a pure object (no codegraph / tsconfig deps, unlike TypeScript); the chunker
 * worker simply never invokes it. `mode` controls ambiguous-resolution
 * behaviour, matching the legacy adapter's `JavascriptCallResolver` default.
 */
export class JavaScriptLanguage implements LanguageProvider {
  readonly kernel = javascriptKernel;
  readonly chunkerHooks: LanguageChunkerHooks = javascriptChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromJavascriptFile(input),
    nameOf: (node) => jsNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new JavascriptCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchFanoutOutcome =>
        callResolver.resolveDispatch?.(call, ctx) ?? emptyDispatchFanout(),
      targetsExternalImport: (call: CallRef, ctx: CallContext): boolean =>
        callResolver.targetsExternalImport?.(call, ctx) ?? false,
    };
  }
}

export { javascriptKernel } from "./kernel.js";
export { JsChunkClassifier, javascriptHooks, jsChunkSymbols } from "./chunking/index.js";
export { extractFromJavascriptFile, jsNameOf } from "./walker/index.js";
export { JavascriptCallResolver, mapJavascriptImportToFile } from "./resolver/index.js";
export type { FileExtraction, JsExtractInput };
