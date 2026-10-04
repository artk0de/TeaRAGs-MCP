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
 * `.claude/rules/test-spec-chunking.md`.
 *
 * ── Language-list pointer (MANDATORY) ────────────────────────────────
 * This hook emits `chunkType: "test"` / `"test_setup"` for Ruby RSpec.
 * The list of languages that support DSL test chunks is published in
 * three skill files that consumers read; when you ADD a new language
 * (or REMOVE one) you MUST update ALL of them in the same commit:
 *
 *   - .claude-plugin/dinopowers/skills/test-driven-development/SKILL.md
 *     (Iron Rule fallback paragraph — supported-languages list)
 *   - .claude-plugin/tea-rags/skills/tests-as-context/SKILL.md
 *     (Step 0 SKIP block — currently-supported parenthesis)
 *   - .claude-plugin/tea-rags/skills/filter-building/SKILL.md
 *     (chunkType section — supported-languages table)
 *
 * The canonical structure for a new language's hook lives in
 * `.claude/rules/test-spec-chunking.md`; that rule file also carries
 * the "update the 3 skills" checklist.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { BodyChunkResult, ChunkingHook, TestScope } from "../../../../contracts/types/chunker.js";
import { produceTestScopeChunks } from "../../kernel/index.js";
import { isRspecFile } from "./rspec-filter.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * An RSpec container read into the kernel's `TestScope`, keeping the call node
 * the `topLevelName` is read from.
 */
export interface RSpecScope extends TestScope {
  node: AstNode;
  children: RSpecScope[];
}

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

// ── Helpers ──────────────────────────────────────────────────────────

function getCallMethodName(node: AstNode, code: string): string | null {
  if (node.type !== "call") return null;
  const id = node.children.find((c) => c.type === "identifier");
  return id ? code.substring(id.startIndex, id.endIndex) : null;
}

/**
 * Extract the scope name from a container call node.
 * For `describe User do` → "describe User"
 * For `context 'when admin' do` → "context 'when admin'"
 * For `RSpec.describe User do` → "RSpec.describe User"
 */
function extractScopeName(node: AstNode, code: string): string {
  const codeLines = code.split("\n");
  const firstLineRow = node.startPosition.row;
  const firstLine = codeLines[firstLineRow];
  /* v8 ignore next -- defensive: firstLine always exists for valid AST node */
  if (!firstLine) return "unknown";

  // Take text from node start to first `do` or `{` or end of line
  const nodeStartCol = node.startPosition.column;
  let lineText = firstLine.substring(nodeStartCol).trim();

  // Remove trailing `do`, `{`, and block params
  lineText = lineText.replace(/\s+do\s*(\|[^|]*\|)?\s*$/, "").trim();
  lineText = lineText.replace(/\s*\{\s*(\|[^|]*\|)?\s*$/, "").trim();

  return lineText || "unknown";
}

/**
 * Find the block body statement node of a container call.
 * Ruby AST: call → do_block → body_statement (contains the actual children).
 */
function findBlockBody(node: AstNode): AstNode | null {
  for (const child of node.children) {
    if (child.type === "do_block" || child.type === "block") {
      // Look for body_statement inside do_block/block
      for (const inner of child.children) {
        if (inner.type === "body_statement" || inner.type === "block_body") {
          return inner;
        }
      }
      // Fallback: return the block itself
      return child;
    }
  }
  return null;
}

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
  const codeLines = code.split("\n");
  const scopeName = extractScopeName(containerNode, code);

  const scope: RSpecScope = {
    name: scopeName,
    node: containerNode,
    startLine: containerNode.startPosition.row + 1,
    endLine: containerNode.endPosition.row + 1,
    setupLines: [],
    examples: [],
    children: [],
    otherLines: [],
  };

  const blockBody = findBlockBody(containerNode);
  if (!blockBody) return scope;

  // Track which rows are claimed by recognized child calls
  const claimedRows = new Set<number>();

  for (const child of blockBody.namedChildren) {
    const methodName = getCallMethodName(child, code);
    if (!methodName) {
      // Not a call node — collect as other lines if non-trivial
      continue;
    }

    if (CONTAINER_METHODS.has(methodName)) {
      // Recurse into nested container
      const childScope = buildScopeTree(child, code);
      scope.children.push(childScope);
      for (let { row } = child.startPosition; row <= child.endPosition.row; row++) {
        claimedRows.add(row);
      }
    } else if (EXAMPLE_METHODS.has(methodName)) {
      // An example — named like a scope, by its call up to the block opener
      // (`it 'returns nil'`, `its(:email)`); a one-line brace block keeps its
      // whole line, the only description a description-less example has.
      const startRow = child.startPosition.row;
      const endRow = child.endPosition.row;
      const itText = codeLines.slice(startRow, endRow + 1).join("\n");
      scope.examples.push({
        name: extractScopeName(child, code),
        text: itText,
        startLine: startRow + 1,
        endLine: endRow + 1,
      });
      for (let row = startRow; row <= endRow; row++) {
        claimedRows.add(row);
      }
    } else if (SETUP_METHODS.has(methodName)) {
      // Collect setup lines
      const startRow = child.startPosition.row;
      const endRow = child.endPosition.row;
      const setupText = codeLines.slice(startRow, endRow + 1).join("\n");
      scope.setupLines.push({
        text: setupText,
        sourceLine: startRow + 1,
        ...(DELEGATING_TEST_METHODS.has(methodName) ? { delegatesExamples: true } : {}),
      });
      for (let row = startRow; row <= endRow; row++) {
        claimedRows.add(row);
      }
    }
  }

  // Collect remaining non-blank lines as otherLines
  // body_statement range covers the actual body content (no do/end wrapper)
  const bodyStartRow = blockBody.startPosition.row;
  const bodyEndRow = blockBody.endPosition.row;
  for (let row = bodyStartRow; row <= bodyEndRow; row++) {
    if (claimedRows.has(row)) continue;
    const lineText = codeLines[row];
    if (lineText !== undefined && lineText.trim().length > 0) {
      scope.otherLines.push({
        text: lineText,
        sourceLine: row + 1,
      });
    }
  }

  return scope;
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
