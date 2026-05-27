/**
 * `RubyLanguage` — the native per-language facade for Ruby, the first vertical
 * migrated off the composition-root legacy adapter into `domains/language/`
 * (spec §2, §4; bd tea-rags-mcp-cen6). Thin: it composes the four capability
 * sub-modules, all of which are pure module-level logic + config that any
 * instance merely references.
 *
 *   kernel        ← ./kernel.ts            (parser load, scopeSeparator "::", detection)
 *   chunkerHooks  ← ./chunking/            (rspec filter/scope, comment-capture, class-body)
 *   walker        ← ./walker/              (extractFromRubyFile + rbNameOf)
 *   resolver      ← ./resolver/            (RubyCallResolver — require/zeitwerk chain)
 *
 * Created per-context by `LanguageFactory` (each owns its own tree-sitter
 * `Parser`, spec §5). The capability logic here is stateless, so the only
 * per-instance cost is the Parser the chunker/codegraph engines build.
 *
 * symbolId macro coverage convergence: the chunker emits synthetic method
 * symbols for class-body macros via `chunker/tree-sitter.ts:emitMacroSymbols`
 * (calling the relocated `extractRubyMacroSymbols` through the factory's walker
 * capability), while the codegraph emits them via `walker.nameOf` (`rbNameOf`).
 * Both MUST stay in lockstep per `.claude/rules/symbolid-convention.md`.
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
import type Parser from "tree-sitter";

import { rubyKernel } from "./kernel.js";
import { rubyHooks } from "./chunking/index.js";
import { extractRubyMacroSymbols, type RubyMacroSymbol } from "./walker/macros.js";
import { rbNameOf } from "./walker/name-of.js";
import { extractFromRubyFile, type RubyExtractInput } from "./walker/walker.js";
import { RubyCallResolver } from "./resolver/ruby-resolver.js";

/**
 * Chunk-boundary config for Ruby — mirrors the chunker slice of the legacy
 * `LANGUAGE_DEFINITIONS.ruby` entry 1:1 (chunkableTypes, childChunkTypes,
 * alwaysExtractChildren, the RSpec `nameExtractor`, and the ordered hook chain).
 */
const rubyChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "method", // def method_name ... end
    "singleton_method", // def self.method_name ... end
    "class", // class Foo ... end (small classes kept whole)
    "module", // module Bar ... end (small modules kept whole)
    "singleton_class", // class << self ... end
    "call", // RSpec describe/context/it (filtered by rspec-filter hook)
  ],
  // When class/module is too large, recursively look for these smaller units.
  // NOTE: "singleton_class" removed from childChunkTypes — we traverse THROUGH
  // it to find the methods inside (class << self ... end contains methods).
  childChunkTypes: ["method", "singleton_method", "call"],
  // In Ruby, virtually all code lives inside class/module. Without this flag,
  // small classes become a single chunk and individual methods are not searchable.
  alwaysExtractChildren: true,
  nameExtractor: (node: Parser.SyntaxNode, code: string): string | undefined => {
    if (node.type !== "call") return undefined;
    const id = node.children.find((c) => c.type === "identifier");
    const methodName = id ? code.substring(id.startIndex, id.endIndex) : "";
    const args = node.childForFieldName("arguments");
    if (args && args.namedChildren.length > 0) {
      const firstArg = args.namedChildren[0];
      const argText = code.substring(firstArg.startIndex, firstArg.endIndex);
      return `${methodName} ${argText}`;
    }
    return methodName || undefined;
  },
  hooks: rubyHooks,
  // Synthetic method symbols from class-body DSL macros (attr_accessor / delegate
  // / define_method / alias). The chunker engine emits a chunk per result.
  macroSymbols: (containerNode) => extractRubyMacroSymbols(containerNode),
};

/**
 * Native Ruby `LanguageProvider`. Construction is cheap — the resolver is a
 * pure object (no codegraph deps); the chunker worker simply never invokes it.
 * `mode` controls ambiguous-resolution behaviour, matching the legacy adapter's
 * `RubyCallResolver` default.
 */
export class RubyLanguage implements LanguageProvider {
  readonly kernel = rubyKernel;
  readonly chunkerHooks: LanguageChunkerHooks = rubyChunkerHooks;
  readonly walker: LanguageWalker = {
    walk: (input) => extractFromRubyFile(input),
    nameOf: (node) => rbNameOf(node),
  };
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new RubyCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): ResolvedTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchEdge[] =>
        callResolver.resolveDispatch?.(call, ctx) ?? [],
    };
  }
}

export { rubyKernel } from "./kernel.js";
export { rubyHooks } from "./chunking/index.js";
export { extractFromRubyFile, rbNameOf, extractRubyMacroSymbols } from "./walker/index.js";
export { RubyCallResolver } from "./resolver/index.js";
export type { FileExtraction, RubyExtractInput, RubyMacroSymbol };
