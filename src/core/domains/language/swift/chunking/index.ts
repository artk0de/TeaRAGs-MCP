/**
 * Swift chunking hook chain — the array `SwiftLanguage.chunkerHooks.hooks`
 * carries. Order is positional and load-bearing; see
 * `.claude/rules/chunker-hooks.md`.
 *
 * ONE hook writes `ctx.bodyChunks`: the Quick scope chunker, which claims a
 * `QuickSpec` subclass declaring a `spec()` method and abstains on everything
 * else — see `./quick-scope-chunker.ts` for why it claims the TYPE and not the
 * method that actually holds the DSL. Every other container's type-level chunk
 * is the ENGINE's container remainder (bd tea-rags-mcp-deoki); Swift once
 * carried its own body chunker re-emitting the engine's old narrow parent, and
 * retired it when the engine began emitting the remainder for hook languages.
 *
 * The metadata hooks only populate `methodChunkTypes` / `containerChunkType` /
 * `methodPrefixes` / `excludedRows`, so the claim short-circuit never fires
 * early on their account.
 */

import type { ChunkingHook } from "../../../../contracts/types/chunker.js";
import { swiftDocCommentCaptureHook } from "./doc-comment-capture.js";
import { swiftNestedFunctionFilterHook } from "./nested-function-filter.js";
import { swiftQuickScopeChunkerHook } from "./quick-scope-chunker.js";
import { swiftSuiteClassificationHook } from "./suite-recognition.js";

export const swiftHooks: ChunkingHook[] = [
  swiftNestedFunctionFilterHook, // filterNode: reject funcs/inits nested in a function body
  swiftSuiteClassificationHook, // metadata: methodChunkTypes + containerChunkType for XCTest / swift-testing / Quick suites
  swiftDocCommentCaptureHook, // metadata: methodPrefixes + excludedRows (the engine's remainder skips excludedRows)
  swiftQuickScopeChunkerHook, // scope chunker: claims a Quick suite, writes bodyChunks + skipChildren
];

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
  toLineRanges,
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
