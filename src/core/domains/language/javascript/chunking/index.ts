/**
 * JavaScript chunker hooks + chunk-symbol capability.
 *
 * Filter chain ordering (per `.claude/rules/chunker-hooks.md`):
 *   1. `jsTestDslFilterHook` — filter-only: accept `call_expression` nodes
 *      only when they name a Vitest/Jest/Mocha DSL method (describe/it/test/
 *      beforeEach/…) AND the file is a test file, so the `call_expression`
 *      in `chunkableTypes` reaches test-scope chunking without turning every
 *      ordinary call site into a chunk candidate (bd tea-rags-mcp-1etj8).
 *   2. `jsAssignmentFilterHook` — filter-only: keep
 *      `expression_statement` / `lexical_declaration` /
 *      `variable_declaration` nodes only when they carry a function value,
 *      so we don't emit chunks for `const x = 1` / `import.meta.url` /
 *      bare statements that have no symbolId.
 *   3. `jsTestScopeChunkerHook` — process: scope-tree → `chunkType: "test"`
 *      / `"test_setup"` chunks for describe/context/suite containers in
 *      test files, `skipChildren = true`.
 *
 * The symbol resolver (`symbol-resolver.ts`) is a pure helper composed into
 * `jsChunkSymbols` (`chunk-symbols.ts`), which `JsChunkClassifier` wraps into
 * `ChunkDecision.emit` — not part of the hook chain — because it runs AFTER the
 * filter passes a node and BEFORE the chunk is pushed (i.e. inside the engine's
 * `chunkSingleNode`, reached via the provider's `LanguageChunkerHooks.classifier`
 * capability, not at hook-process time).
 *
 * bd tea-rags-mcp-kfzx
 */
import type { ChunkingHook } from "../../../../contracts/types/chunker.js";
import { jsAssignmentFilterHook } from "./assignment-filter.js";
import { jsTestDslFilterHook } from "./test-dsl-filter.js";
import { jsTestScopeChunkerHook } from "./test-scope-chunker.js";

export const javascriptHooks: ChunkingHook[] = [jsTestDslFilterHook, jsAssignmentFilterHook, jsTestScopeChunkerHook];

export { jsAssignmentFilterHook } from "./assignment-filter.js";
export { jsExportNameExtractor } from "./name-extractor.js";
export { jsChunkSymbols } from "./chunk-symbols.js";
export { JsChunkClassifier } from "./classifier.js";
export {
  extractJsAssignmentSymbol,
  extractJsForEachDispatchSymbols,
  extractJsNestedDefinePropertyThisSymbols,
  type JsAssignmentSymbol,
} from "./symbol-resolver.js";
export { jsTestDslFilterHook, isTestFile, getCallName } from "./test-dsl-filter.js";
export {
  jsTestScopeChunkerHook,
  isDslContainerCall,
  buildScopeTree,
  produceScopeChunks,
} from "./test-scope-chunker.js";
export type { ItBlock, SetupLine, TestScope } from "./test-scope-chunker.js";
