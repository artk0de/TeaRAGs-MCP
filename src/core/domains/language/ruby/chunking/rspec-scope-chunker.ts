/**
 * RSpec Scope Chunker — reads an RSpec container call into the neutral
 * `TestScope` tree and hands it to the kernel (`produceTestScopeChunks`,
 * bd tea-rags-mcp-99gkm under epic tea-rags-mcp-phftd).
 *
 * This hook owns only the RSpec reading: which calls are containers, examples
 * and setup, the display names (`describe User`, `context 'when admin'`,
 * `it 'can invite'`), which setup calls run shared examples
 * (`delegatesExamples`), and the `topLevelName`. The kernel owns what the
 * chunks are, their ids (`<Top>.<scope>` scope, `<Top>.<scope>.<example>`
 * example, `~N` on repeats), the inherited-setup splice and the line ranges —
 * `.claude/rules/test-spec-chunking.md`. The tree walk is the shared Ruby DSL
 * reader (`dsl-scope-tree.ts`, also Rake's); this file holds RSpec's
 * vocabulary for it.
 *
 * ── Language-list pointer (MANDATORY) ────────────────────────────────
 * This hook emits `chunkType: "test"` / `"test_setup"` for Ruby RSpec.
 * The list of languages that support DSL test chunks is published in
 * three skill files that consumers read; when you ADD a new language
 * (or REMOVE one) you MUST update ALL of them in the same commit:
 *
 *   - plugins/dinopowers/skills/test-driven-development/SKILL.md
 *     (Iron Rule fallback paragraph — supported-languages list)
 *   - plugins/tea-rags/skills/tests-as-context/SKILL.md
 *     (Step 0 SKIP block — currently-supported parenthesis)
 *   - plugins/tea-rags/skills/filter-building/SKILL.md
 *     (chunkType section — supported-languages table)
 *
 * The canonical structure for a new language's hook lives in
 * `.claude/rules/test-spec-chunking.md`; that rule file also carries
 * the "update the 3 skills" checklist.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { BodyChunkResult, ChunkingHook } from "../../../../contracts/types/chunker.js";
import { produceTestScopeChunks } from "../../kernel/index.js";
import { readRubyDslScopeTree, type RubyDslScope, type RubyDslScopeVocabulary } from "./dsl-scope-tree.js";
import { isRspecFile } from "./rspec-filter.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * An RSpec container read into the kernel's `TestScope`, keeping the call node
 * the `topLevelName` is read from.
 */
export type RSpecScope = RubyDslScope;

// ── Constants ────────────────────────────────────────────────────────

const CONTAINER_METHODS = new Set([
  "describe",
  "context",
  "feature",
  "shared_examples",
  "shared_context",
  "shared_examples_for",
]);

const EXAMPLE_METHODS = new Set([
  "it",
  "specify",
  "example",
  "scenario",
  "its",
  "xit",
  "xspecify",
  "xexample",
  "fit",
  "fspecify",
  "fexample",
]);

const SETUP_METHODS = new Set([
  "let",
  "let!",
  "subject",
  "before",
  "after",
  "around",
  "shared_context",
  "include_context",
  "it_behaves_like",
  "include_examples",
]);

/** Setup methods that delegate to actual tests (shared examples). */
const DELEGATING_TEST_METHODS = new Set(["it_behaves_like", "include_examples"]);

/** The RSpec roles of the shared Ruby DSL scope-tree reader. */
const RSPEC_SCOPE_VOCABULARY: RubyDslScopeVocabulary = {
  containerMethods: CONTAINER_METHODS,
  leafMethods: EXAMPLE_METHODS,
  setupMethods: SETUP_METHODS,
  delegatingSetupMethods: DELEGATING_TEST_METHODS,
  descriptionMethods: new Set(),
  unscopedLeafMethods: new Set(),
  collectRowsAboveBody: false,
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract top-level describe name for the root symbolId component.
 * For `describe User do` → "User"
 * For `RSpec.describe User do` → "User"
 * For `describe 'MyService' do` → "MyService"
 */
function extractTopLevelName(scope: RSpecScope, code: string): string {
  const args = scope.node.childForFieldName("arguments");
  if (args) {
    for (const arg of args.namedChildren) {
      if (arg.type === "constant" || arg.type === "scope_resolution") {
        return code.substring(arg.startIndex, arg.endIndex);
      }
      if (arg.type === "string" || arg.type === "simple_string") {
        const text = code.substring(arg.startIndex, arg.endIndex);
        // Remove quotes
        return text.replace(/^['"]|['"]$/g, "");
      }
    }
  }
  // Fallback: use scope name
  return scope.name;
}

// ── Core: buildScopeTree ─────────────────────────────────────────────

export function buildScopeTree(containerNode: AstNode, code: string): RSpecScope {
  return readRubyDslScopeTree(containerNode, code, RSPEC_SCOPE_VOCABULARY);
}

// ── Core: produceScopeChunks ─────────────────────────────────────────

/**
 * The chunks of one RSpec container: the kernel's emission over the scope
 * tree, rooted at the container's subject (`User` for `describe User`).
 */
export function produceScopeChunks(
  rootScope: RSpecScope,
  code: string,
  config: { maxChunkSize: number },
): BodyChunkResult[] {
  return produceTestScopeChunks(rootScope, extractTopLevelName(rootScope, code), config);
}

// ── Hook export ──────────────────────────────────────────────────────

export const rspecScopeChunkerHook: ChunkingHook = {
  name: "rspec-scope-chunker",

  process(ctx) {
    if (!isRspecFile(ctx.filePath)) return;

    const tree = buildScopeTree(ctx.containerNode, ctx.code);
    const chunks = produceScopeChunks(tree, ctx.code, ctx.config);

    if (chunks.length > 0) {
      ctx.bodyChunks = chunks;
      ctx.skipChildren = true;
    }
  },
};
