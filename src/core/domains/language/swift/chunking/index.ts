/**
 * Swift chunking hook chain — the array `SwiftLanguage.chunkerHooks.hooks`
 * carries. Order is positional and load-bearing; see
 * `.claude/rules/chunker-hooks.md`.
 *
 * Exactly one hook writes `ctx.bodyChunks`, and it is last. The two metadata
 * hooks before it only populate `methodChunkTypes` / `methodPrefixes` /
 * `excludedRows`, so the orchestrator's claim short-circuit never fires early.
 */

import type { ChunkingHook } from "../../../../contracts/types/chunker.js";
import { swiftContainerBodyChunkerHook } from "./container-body-chunker.js";
import { swiftDocCommentCaptureHook } from "./doc-comment-capture.js";
import { swiftNestedFunctionFilterHook } from "./nested-function-filter.js";
import { swiftSuiteClassificationHook } from "./suite-recognition.js";

export const swiftHooks: ChunkingHook[] = [
  swiftNestedFunctionFilterHook, // filterNode: reject funcs/inits nested in a function body
  swiftSuiteClassificationHook, // metadata: methodChunkTypes for XCTest / swift-testing members
  swiftDocCommentCaptureHook, // metadata: methodPrefixes + excludedRows (must precede body chunker)
  swiftContainerBodyChunkerHook, // body chunker (last): reads excludedRows, writes bodyChunks
];

export { extractSwiftContainerBody, swiftContainerBodyChunkerHook } from "./container-body-chunker.js";
export { collectSwiftDocComments, swiftDocCommentCaptureHook } from "./doc-comment-capture.js";
export { isNestedInsideFunctionBody, swiftNestedFunctionFilterHook } from "./nested-function-filter.js";
export {
  classifySwiftSuiteMember,
  detectSwiftSuiteKind,
  isSwiftTestFile,
  swiftSuiteClassificationHook,
  type SwiftSuiteKind,
} from "./suite-recognition.js";
