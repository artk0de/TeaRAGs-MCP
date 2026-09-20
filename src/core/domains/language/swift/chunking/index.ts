/**
 * Swift chunking hook chain — the array `SwiftLanguage.chunkerHooks.hooks`
 * carries. Order is positional and load-bearing; see
 * `.claude/rules/chunker-hooks.md`.
 *
 * TWO hooks write `ctx.bodyChunks`, and the engine stops the chain at the first
 * one that does, so their ORDER is the contract between them. The Quick scope
 * chunker runs first and abstains on everything that is not a `QuickSpec`
 * subclass declaring a `spec()` method; the container body chunker then claims
 * every other container exactly as it does today. Both claim the TYPE
 * declaration — see `./quick-scope-chunker.ts` for why the scope chunker cannot
 * claim the method that actually holds the DSL.
 *
 * The metadata hooks in between only populate `methodChunkTypes` /
 * `methodPrefixes` / `excludedRows`, so the claim short-circuit never fires
 * early on their account.
 */

import type { ChunkingHook } from "../../../../contracts/types/chunker.js";
import { swiftContainerBodyChunkerHook } from "./container-body-chunker.js";
import { swiftDocCommentCaptureHook } from "./doc-comment-capture.js";
import { swiftNestedFunctionFilterHook } from "./nested-function-filter.js";
import { swiftQuickScopeChunkerHook } from "./quick-scope-chunker.js";
import { swiftSuiteClassificationHook } from "./suite-recognition.js";

export const swiftHooks: ChunkingHook[] = [
  swiftNestedFunctionFilterHook, // filterNode: reject funcs/inits nested in a function body
  swiftSuiteClassificationHook, // metadata: methodChunkTypes for XCTest / swift-testing / Quick members
  swiftDocCommentCaptureHook, // metadata: methodPrefixes + excludedRows (must precede body chunker)
  swiftQuickScopeChunkerHook, // scope chunker: claims a Quick suite, writes bodyChunks + skipChildren
  swiftContainerBodyChunkerHook, // body chunker (last): reads excludedRows, writes bodyChunks
];

export { extractSwiftContainerBody, swiftContainerBodyChunkerHook, toLineRanges } from "./container-body-chunker.js";
export { collectSwiftDocComments, swiftDocCommentCaptureHook } from "./doc-comment-capture.js";
export { isNestedInsideFunctionBody, swiftNestedFunctionFilterHook } from "./nested-function-filter.js";
export {
  getSwiftCallName,
  isQuickSpecFile,
  QUICK_CONTAINER_METHODS,
  QUICK_DSL_METHODS,
  QUICK_EXAMPLE_METHODS,
  QUICK_SETUP_METHODS,
} from "./quick-dsl.js";
export {
  buildQuickScopeTree,
  produceQuickScopeChunks,
  swiftQuickScopeChunkerHook,
  type QuickItBlock,
  type QuickSetupLine,
  type QuickTestScope,
} from "./quick-scope-chunker.js";
export {
  classifySwiftSuiteMember,
  detectSwiftSuiteKind,
  isQuickSpecMethod,
  isQuickSuite,
  isSwiftTestFile,
  quickSpecMethods,
  swiftSuiteClassificationHook,
  type SwiftSuiteKind,
} from "./suite-recognition.js";
