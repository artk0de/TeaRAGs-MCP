import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  emptyDispatchFanout,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchFanoutOutcome,
  type FileExtraction,
  type GraphEdges,
  type SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { composeExtractionWalker } from "../kernel/index.js";
import { phpKernel } from "./kernel.js";
import { PhpCallResolver } from "./resolver/index.js";
import { phpNameOf } from "./walker/name-of.js";
import { PHP_EXTRACTION_PASSES } from "./walker/passes.js";
import { extractFromPhpFile, type PhpExtractInput } from "./walker/walker.js";

const phpChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "method_declaration",
    "function_definition",
    "class_declaration",
    "interface_declaration",
    "trait_declaration",
    "enum_declaration",
  ],
  childChunkTypes: ["method_declaration", "function_definition"],
  alwaysExtractChildren: true,
  keepShortChildChunkTypes: ["method_declaration", "function_definition"],
};

export class PhpLanguage implements LanguageProvider {
  readonly kernel = phpKernel;
  readonly chunkerHooks: LanguageChunkerHooks = phpChunkerHooks;
  readonly walker: LanguageWalker = composeExtractionWalker({
    walk: (input) => extractFromPhpFile(input),
    nameOf: (node) => phpNameOf(node),
    passes: PHP_EXTRACTION_PASSES,
  });
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new PhpCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchFanoutOutcome =>
        callResolver.resolveDispatch?.(call, ctx) ?? emptyDispatchFanout(),
      resolveFileEdges: (extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] =>
        callResolver.resolveFileEdges?.(extraction, ctx) ?? [],
    };
  }
}

export { phpKernel } from "./kernel.js";
export { extractFromPhpFile, phpNameOf } from "./walker/index.js";
export { PhpCallResolver } from "./resolver/index.js";
export type { FileExtraction, PhpExtractInput };
