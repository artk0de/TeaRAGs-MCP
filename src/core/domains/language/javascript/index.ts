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
 * Created per-context by `LanguageFactory` (each owns its own tree-sitter
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

import type {
  AmbiguousResolveMode,
  CallContext,
  CallRef,
  CallResolver,
  DispatchEdge,
  FileExtraction,
  ResolvedTarget,
} from "../../../contracts/types/codegraph.js";
import { DEFAULT_AMBIGUOUS_RESOLVE_MODE } from "../../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";

import { javascriptKernel } from "./kernel.js";
import { JsChunkClassifier, javascriptHooks, jsChunkSymbols } from "./chunking/index.js";
import { jsNameOf } from "./walker/name-of.js";
import { extractFromJavascriptFile, type JsExtractInput } from "./walker/walker.js";
import { JavascriptCallResolver } from "./resolver/index.js";

/**
 * Chunk-boundary config for JavaScript — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.javascript` entry 1:1 (chunkableTypes + the ordered hook
 * chain), PLUS the node-level `chunkSymbols` capability (the analog of Ruby's
 * `macroSymbols`) the engine reads in `chunkSingleNode`. No `childChunkTypes` /
 * `alwaysExtractChildren` / `nameExtractor` — JavaScript declares none (its
 * containers are the same `class_declaration` / `function_declaration` shapes
 * TypeScript handles via the default extraction).
 */
const javascriptChunkerHooks: LanguageChunkerHooks = {
  // `expression_statement` / `lexical_declaration` / `variable_declaration` are
  // kept ONLY when they carry a function value — `jsAssignmentFilterHook` drops
  // the others so we don't chunk `const x = 1` / bare statements with no
  // symbolId. The symbolId is then composed by `chunkSymbols` (jsChunkSymbols).
  chunkableTypes: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "export_statement",
    "expression_statement",
    "lexical_declaration",
    "variable_declaration",
  ],
  hooks: javascriptHooks,
  // Node-level synthetic CHUNK symbols (CommonJS `obj.method = fn` / `exports.foo`
  // / `module.exports`, `Foo.prototype.bar`, `const Bar = fn`, the
  // `methods.forEach` HTTP-verb dispatch fan-out, and nested
  // `Object.defineProperty(this, …)` getter installs). symbolIds are ALREADY
  // composed — the engine emits each verbatim at `index + i`.
  chunkSymbols: (node) => jsChunkSymbols(node),
  // Node→chunk classifier capability — the LanguageChunkClassifier wrapper over
  // jsChunkSymbols. Set alongside `chunkSymbols` (both coexist); dormant until
  // the engine reroute reads `classifier` instead.
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
      resolve: (call: CallRef, ctx: CallContext): ResolvedTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchEdge[] =>
        callResolver.resolveDispatch?.(call, ctx) ?? [],
    };
  }
}

export { javascriptKernel } from "./kernel.js";
export { JsChunkClassifier, javascriptHooks, jsChunkSymbols } from "./chunking/index.js";
export { extractFromJavascriptFile, jsNameOf } from "./walker/index.js";
export { JavascriptCallResolver, mapJavascriptImportToFile } from "./resolver/index.js";
export type { FileExtraction, JsExtractInput };
