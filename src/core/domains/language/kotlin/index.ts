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
import { kotlinKernel } from "./kernel.js";
import { KotlinCallResolver } from "./resolver/index.js";
import { kotlinNameOf } from "./walker/name-of.js";
import { KOTLIN_EXTRACTION_PASSES } from "./walker/passes.js";
import { extractFromKotlinFile, type KotlinExtractInput } from "./walker/walker.js";

const kotlinChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: ["function_declaration", "class_declaration", "object_declaration"],
  childChunkTypes: ["function_declaration"],
  alwaysExtractChildren: true,
  keepShortChildChunkTypes: ["function_declaration"],
};

export class KotlinLanguage implements LanguageProvider {
  readonly kernel = kotlinKernel;
  readonly chunkerHooks: LanguageChunkerHooks = kotlinChunkerHooks;
  readonly walker: LanguageWalker = composeExtractionWalker({
    walk: (input) => extractFromKotlinFile(input),
    nameOf: (node) => kotlinNameOf(node),
    passes: KOTLIN_EXTRACTION_PASSES,
  });
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new KotlinCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchFanoutOutcome =>
        callResolver.resolveDispatch?.(call, ctx) ?? emptyDispatchFanout(),
      resolveFileEdges: (extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] =>
        callResolver.resolveFileEdges?.(extraction, ctx) ?? [],
    };
  }
}

export { kotlinKernel } from "./kernel.js";
export { extractFromKotlinFile, kotlinNameOf } from "./walker/index.js";
export { KotlinCallResolver } from "./resolver/index.js";
export type { FileExtraction, KotlinExtractInput };
