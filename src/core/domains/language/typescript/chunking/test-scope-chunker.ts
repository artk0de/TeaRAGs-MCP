/**
 * Test-Spec Scope Chunker — reads Vitest/Jest/Mocha-style test specs into the
 * neutral `TestScope` tree (`contracts/types/chunker.ts`) and hands it to the
 * kernel's `produceTestScopeChunks`, which emits one chunk per EXAMPLE
 * (bd tea-rags-mcp-b55x2, epic tea-rags-mcp-phftd). TypeScript AST:
 * call_expression + arrow_function/function_expression callbacks +
 * statement_block bodies.
 *
 * This file owns only the TypeScript reading — which calls are containers,
 * examples and hooks, what a scope or example is called, and the top-level
 * name. Chunk shape, symbolIds, `~N` and line ranges are the kernel's
 * (`.claude/rules/test-spec-chunking.md`).
 *
 * ── Language-list pointer (MANDATORY) ────────────────────────────────
 * This hook emits `chunkType: "test"` / `"test_setup"` for TypeScript.
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
import type { BodyChunkResult, ChunkingHook, HookContext, TestScope } from "../../../../contracts/types/chunker.js";
import { produceTestScopeChunks } from "../../kernel/index.js";
import { getCallDisplayName, getCallName, isTestFile } from "./test-dsl-filter.js";

// ── Constants ────────────────────────────────────────────────────────

const CONTAINER_METHODS = new Set(["describe", "context", "suite"]);

const EXAMPLE_METHODS = new Set(["it", "test", "bench", "fit", "ftest", "xit", "xtest"]);

const SETUP_METHODS = new Set([
  "beforeEach",
  "beforeAll",
  "afterEach",
  "afterAll",
  "before",
  "after",
  "setup",
  "teardown",
]);

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * If `node` is a statement that wraps a call_expression (typically
 * expression_statement), return the inner call_expression. Otherwise
 * return null.
 */
function unwrapStatementCall(node: AstNode): AstNode | null {
  if (node.type === "call_expression") return node;
  if (node.type === "expression_statement") {
    const inner = node.namedChildren.find((c) => c.type === "call_expression");
    return inner ?? null;
  }
  return null;
}

function isCallback(node: AstNode): boolean {
  return node.type === "arrow_function" || node.type === "function_expression";
}

/**
 * Find the callback body (statement_block) for a DSL call.
 * Returns null when the call has no arrow_function / function_expression
 * argument (e.g. `describe(User)` with no callback).
 */
function findCallbackBody(node: AstNode): AstNode | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (isCallback(arg)) {
      const body = arg.childForFieldName("body");
      if (body?.type === "statement_block") return body;
    }
  }
  return null;
}

/**
 * True when an example-named call is shaped like an example: its arguments
 * carry a string / template title or a callback — `it('x', fn)`,
 * `it.todo('x')`, `it(title, () => …)`, `it.each(t)('x', fn)`. A call with
 * neither — `test(app)`, a shared-behaviour helper that happens to be named
 * `test` — is an ordinary statement of its scope (bd tea-rags-mcp-c0vdv).
 */
function isExampleShaped(node: AstNode): boolean {
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  const [title] = args;
  if (title?.type === "string" || title?.type === "template_string") return true;
  return args.some(isCallback);
}

/**
 * The display name of a scope or example: the call as written plus its first
 * argument — `describe 'User'`, `context "when admin"`, `it.skip 'pending'`,
 * `it.each 'adds %i'`. The argument is kept verbatim (quotes included) with
 * line breaks folded to one space, so the name is one line and still greps
 * back to the source. A call whose first argument is its callback is named by
 * the call alone.
 */
function extractScopeName(node: AstNode, code: string): string {
  const callName = getCallDisplayName(node, code) ?? "unknown";
  const firstArg = node.childForFieldName("arguments")?.namedChildren[0];
  if (!firstArg || isCallback(firstArg)) return callName;

  const argText = code.substring(firstArg.startIndex, firstArg.endIndex).replace(/\s*\n\s*/g, " ");
  return `${callName} ${argText}`;
}

/**
 * Extract the top-level symbol name from a describe(NAME, ...) call.
 * Identifier → its text. String/template literal → stripped of surrounding
 * quotes/backticks. Falls back to the scope's full name when no arg fits.
 */
export function extractTopLevelName(containerNode: AstNode, code: string): string {
  const args = containerNode.childForFieldName("arguments");
  if (args) {
    for (const arg of args.namedChildren) {
      if (arg.type === "identifier") {
        return code.substring(arg.startIndex, arg.endIndex);
      }
      if (arg.type === "string" || arg.type === "template_string") {
        const text = code.substring(arg.startIndex, arg.endIndex);
        return text.replace(/^['"`]|['"`]$/g, "");
      }
    }
  }
  return extractScopeName(containerNode, code);
}

/** True when `node` is a DSL container call (describe / context / suite). */
export function isDslContainerCall(node: AstNode, code: string): boolean {
  if (node.type !== "call_expression") return false;
  const name = getCallName(node, code);
  return name !== null && CONTAINER_METHODS.has(name);
}

// ── Core: buildScopeTree ─────────────────────────────────────────────

/**
 * Read a container call into the neutral scope tree. Setup is the scope's own
 * hooks only — the kernel inherits ancestors'. No TypeScript construct runs
 * examples defined elsewhere, so no line carries `delegatesExamples`: a
 * parametrized `it.each(table)(name, fn)` is ONE example here, not a
 * delegation.
 */
export function buildScopeTree(containerNode: AstNode, code: string): TestScope {
  const codeLines = code.split("\n");

  const scope: TestScope = {
    name: extractScopeName(containerNode, code),
    startLine: containerNode.startPosition.row + 1,
    endLine: containerNode.endPosition.row + 1,
    setupLines: [],
    otherLines: [],
    examples: [],
    children: [],
  };

  const blockBody = findCallbackBody(containerNode);
  if (!blockBody) return scope;

  const claimedRows = new Set<number>();
  const claim = (node: AstNode): string => {
    for (let { row } = node.startPosition; row <= node.endPosition.row; row++) claimedRows.add(row);
    return codeLines.slice(node.startPosition.row, node.endPosition.row + 1).join("\n");
  };

  for (const child of blockBody.namedChildren) {
    const call = unwrapStatementCall(child);
    if (!call) {
      // Non-call statement (lexical_declaration, return, etc.) — fall
      // through to otherLines collection below.
      continue;
    }

    const methodName = getCallName(call, code);
    if (!methodName) continue;

    if (CONTAINER_METHODS.has(methodName)) {
      scope.children.push(buildScopeTree(call, code));
      claim(child);
    } else if (EXAMPLE_METHODS.has(methodName) && isExampleShaped(call)) {
      scope.examples.push({
        name: extractScopeName(call, code),
        text: claim(child),
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      });
    } else if (SETUP_METHODS.has(methodName)) {
      scope.setupLines.push({ text: claim(child), sourceLine: child.startPosition.row + 1 });
    }
  }

  // Collect remaining non-blank lines in the body as otherLines.
  // statement_block in tree-sitter-typescript includes the surrounding `{`
  // and `}` rows. Ruby's body_statement excludes do/end; we mimic that by
  // skipping the boundary rows when the body spans multiple lines.
  const bodyStartRow = blockBody.startPosition.row;
  const bodyEndRow = blockBody.endPosition.row;
  const innerStart = bodyStartRow === bodyEndRow ? bodyStartRow : bodyStartRow + 1;
  const innerEnd = bodyStartRow === bodyEndRow ? bodyEndRow : bodyEndRow - 1;
  for (let row = innerStart; row <= innerEnd; row++) {
    if (claimedRows.has(row)) continue;
    const lineText = codeLines[row];
    if (lineText !== undefined && lineText.trim().length > 0) {
      scope.otherLines.push({ text: lineText, sourceLine: row + 1 });
    }
  }

  return scope;
}

// ── Core: produceScopeChunks ─────────────────────────────────────────

/** The chunks of one top-level container call: its scope tree, emitted by the kernel. */
export function produceScopeChunks(
  containerNode: AstNode,
  code: string,
  config: { maxChunkSize: number },
): BodyChunkResult[] {
  return produceTestScopeChunks(buildScopeTree(containerNode, code), extractTopLevelName(containerNode, code), config);
}

// ── Hook export ──────────────────────────────────────────────────────

export const testScopeChunkerHook: ChunkingHook = {
  name: "test-scope-chunker",

  process(ctx: HookContext): void {
    if (!isTestFile(ctx.filePath)) return;
    if (ctx.containerNode.type !== "call_expression") return;
    if (!isDslContainerCall(ctx.containerNode, ctx.code)) return;

    const chunks = produceScopeChunks(ctx.containerNode, ctx.code, ctx.config);

    if (chunks.length > 0) {
      ctx.bodyChunks = chunks;
      ctx.skipChildren = true;
    }
  },
};
