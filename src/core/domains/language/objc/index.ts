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
import { composeExtractionWalker } from "../kernel/index.js";
import { objcKernel } from "./kernel.js";
import { ObjcCallResolver } from "./resolver/index.js";
import { objcNameOf } from "./walker/name-of.js";
import { OBJC_EXTRACTION_PASSES } from "./walker/passes.js";
import { extractFromObjcFile, type ObjcExtractInput } from "./walker/walker.js";

const objcChunkerHooks: LanguageChunkerHooks = {
  chunkableTypes: [
    "method_definition",
    "method_declaration",
    "function_definition",
    "class_implementation",
    "class_interface",
    "protocol_declaration",
  ],
  childChunkTypes: ["method_definition", "method_declaration", "function_definition"],
  alwaysExtractChildren: true,
  keepShortChildChunkTypes: ["method_declaration"],
};

export class ObjcLanguage implements LanguageProvider {
  readonly kernel = objcKernel;
  readonly chunkerHooks: LanguageChunkerHooks = objcChunkerHooks;
  readonly walker: LanguageWalker = composeExtractionWalker({
    walk: (input) => extractFromObjcFile(input),
    nameOf: (node) => objcNameOf(node),
    passes: OBJC_EXTRACTION_PASSES,
  });
  readonly resolver: LanguageSymbolResolver;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const callResolver: CallResolver = new ObjcCallResolver(mode);
    this.resolver = {
      resolve: (call: CallRef, ctx: CallContext): SymbolResolutionTarget | null => callResolver.resolve(call, ctx),
      resolveDispatch: (call: CallRef, ctx: CallContext): DispatchFanoutOutcome =>
        callResolver.resolveDispatch?.(call, ctx) ?? emptyDispatchFanout(),
    };
  }
}

export { objcKernel } from "./kernel.js";
export { extractFromObjcFile, objcNameOf } from "./walker/index.js";
export { ObjcCallResolver } from "./resolver/index.js";
export type { FileExtraction, ObjcExtractInput };
