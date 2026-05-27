import type { ChunkingHook } from "../../../../contracts/types/chunker.js";
import { typescriptBodyChunkingHook } from "./class-body-chunker.js";
import { typescriptCommentCaptureHook } from "./comment-capture.js";
import { testDslFilterHook } from "./test-dsl-filter.js";
import { testScopeChunkerHook } from "./test-scope-chunker.js";

export const typescriptHooks: ChunkingHook[] = [
  testDslFilterHook, // filterNode: accept DSL call_expression in test files only
  typescriptCommentCaptureHook, // Must run before body chunker (populates excludedRows)
  testScopeChunkerHook, // process: scope-tree → chunks for describe/context/suite, skipChildren=true
  typescriptBodyChunkingHook, // Reads excludedRows; non-DSL containers still chunked normally
];

export { typescriptBodyChunkingHook, extractBodyChunks } from "./class-body-chunker.js";
export { typescriptCommentCaptureHook } from "./comment-capture.js";
export { testDslFilterHook, isTestFile, getCallName } from "./test-dsl-filter.js";
export { testScopeChunkerHook, isDslContainerCall, buildScopeTree, produceScopeChunks } from "./test-scope-chunker.js";
export { findClassBody } from "./utils.js";
