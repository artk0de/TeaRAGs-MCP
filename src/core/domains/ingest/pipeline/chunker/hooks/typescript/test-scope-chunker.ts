/**
 * Test-Spec Scope Chunker — Groups Vitest/Jest/Mocha-style test specs by
 * scope hierarchy. Mirror of hooks/ruby/rspec-scope-chunker.ts adapted to
 * TypeScript AST (call_expression + arrow_function/function_expression
 * callbacks + statement_block bodies).
 *
 * Instead of treating an entire describe body as one flat chunk, this
 * hook walks the AST to build a scope tree and produces focused chunks
 * per leaf scope. Each leaf chunk includes inherited setup (beforeEach,
 * beforeAll, etc.) from ancestor scopes for self-contained context.
 *
 * Chunks get a 2-level symbolId: "TopLevelDescribe.leafScopeName".
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

import type Parser from "tree-sitter";

import type { BodyChunkResult, ChunkingHook, HookContext } from "../types.js";
import { getCallName, isTestFile } from "./test-dsl-filter.js";

// ── Types ────────────────────────────────────────────────────────────

export interface SetupLine {
  text: string;
  sourceLine: number;
}

export interface ItBlock {
  text: string;
  startLine: number;
  endLine: number;
}

export interface TestScope {
  name: string;
  node: Parser.SyntaxNode;
  isLeaf: boolean;
  setupLines: SetupLine[];
  ownItBlocks: ItBlock[];
  children: TestScope[];
  otherLines: SetupLine[];
}

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
function unwrapStatementCall(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === "call_expression") return node;
  if (node.type === "expression_statement") {
    const inner = node.namedChildren.find((c) => c.type === "call_expression");
    return inner ?? null;
  }
  return null;
}

/**
 * Find the callback body (statement_block) for a DSL call.
 * Returns null when the call has no arrow_function / function_expression
 * argument (e.g. `describe(User)` with no callback).
 */
function findCallbackBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (arg.type === "arrow_function" || arg.type === "function_expression") {
      const body = arg.childForFieldName("body");
      if (body?.type === "statement_block") return body;
    }
  }
  return null;
}

/**
 * Build the descriptive scope name: "describe 'User'", "context 'when admin'",
 * "it.skip 'pending'". Mirrors Ruby extractScopeName output format.
 */
function extractScopeName(node: Parser.SyntaxNode, code: string): string {
  const callName = getCallName(node, code) ?? "unknown";
  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildren.length === 0) return callName;

  const firstArg = args.namedChildren[0];
  const argText = code.substring(firstArg.startIndex, firstArg.endIndex);
  return `${callName} ${argText}`;
}

/**
 * Extract the top-level symbol name from a describe(NAME, ...) call.
 * Identifier → its text. String/template literal → stripped of surrounding
 * quotes/backticks. Falls back to the scope's full name when no arg fits.
 */
function extractTopLevelName(scope: TestScope, code: string): string {
  const args = scope.node.childForFieldName("arguments");
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
  return scope.name;
}

/** True when `node` is a DSL container call (describe / context / suite). */
export function isDslContainerCall(node: Parser.SyntaxNode, code: string): boolean {
  if (node.type !== "call_expression") return false;
  const name = getCallName(node, code);
  return name !== null && CONTAINER_METHODS.has(name);
}

// ── Core: buildScopeTree ─────────────────────────────────────────────

export function buildScopeTree(containerNode: Parser.SyntaxNode, code: string): TestScope {
  const codeLines = code.split("\n");
  const scopeName = extractScopeName(containerNode, code);

  const scope: TestScope = {
    name: scopeName,
    node: containerNode,
    isLeaf: true,
    setupLines: [],
    ownItBlocks: [],
    children: [],
    otherLines: [],
  };

  const blockBody = findCallbackBody(containerNode);
  if (!blockBody) return scope;

  const claimedRows = new Set<number>();

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
      const childScope = buildScopeTree(call, code);
      scope.children.push(childScope);
      scope.isLeaf = false;
      for (let { row } = child.startPosition; row <= child.endPosition.row; row++) {
        claimedRows.add(row);
      }
    } else if (EXAMPLE_METHODS.has(methodName)) {
      const startRow = child.startPosition.row;
      const endRow = child.endPosition.row;
      const itText = codeLines.slice(startRow, endRow + 1).join("\n");
      scope.ownItBlocks.push({
        text: itText,
        startLine: startRow + 1,
        endLine: endRow + 1,
      });
      for (let row = startRow; row <= endRow; row++) {
        claimedRows.add(row);
      }
    } else if (SETUP_METHODS.has(methodName)) {
      const startRow = child.startPosition.row;
      const endRow = child.endPosition.row;
      const setupText = codeLines.slice(startRow, endRow + 1).join("\n");
      scope.setupLines.push({
        text: setupText,
        sourceLine: startRow + 1,
      });
      for (let row = startRow; row <= endRow; row++) {
        claimedRows.add(row);
      }
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
      scope.otherLines.push({
        text: lineText,
        sourceLine: row + 1,
      });
    }
  }

  return scope;
}

// ── Core: produceScopeChunks ─────────────────────────────────────────

export function produceScopeChunks(
  rootScope: TestScope,
  code: string,
  config: { maxChunkSize: number },
): BodyChunkResult[] {
  const topLevelName = extractTopLevelName(rootScope, code);
  const results: BodyChunkResult[] = [];

  function collectParentSetup(_scope: TestScope, ancestors: TestScope[]): string[] {
    const parts: string[] = [];
    for (const ancestor of ancestors) {
      for (const setup of ancestor.setupLines) {
        parts.push(setup.text);
      }
    }
    return parts;
  }

  function walk(scope: TestScope, ancestors: TestScope[]): void {
    if (scope.isLeaf) {
      if (scope.ownItBlocks.length > 0) {
        const parentSetup = collectParentSetup(scope, ancestors);
        const setupParts = [...parentSetup, ...scope.setupLines.map((s) => s.text)];
        const otherParts = scope.otherLines.map((o) => o.text);
        const itParts = scope.ownItBlocks.map((b) => b.text);

        const contentParts = [...setupParts, ...otherParts, ...itParts];
        const content = contentParts.join("\n").trim();

        if (content.length < 50) return;

        // Oversized split — per-it chunks with shared setup duplicated.
        if (content.length > config.maxChunkSize && scope.ownItBlocks.length > 1) {
          const sharedSetup = [...setupParts, ...otherParts].join("\n").trim();
          for (const itBlock of scope.ownItBlocks) {
            const subContent = sharedSetup ? `${sharedSetup}\n${itBlock.text}` : itBlock.text;
            if (subContent.trim().length < 50) continue;
            results.push({
              content: subContent.trim(),
              startLine: itBlock.startLine,
              endLine: itBlock.endLine,
              chunkType: "test",
              symbolId: `${topLevelName}.${scope.name}`,
              name: scope.name,
              parentSymbolId: topLevelName,
            });
          }
          return;
        }

        // Line range derived from this scope's own lines only — ancestor
        // setup is in the content for context but must NOT inflate the
        // range (would break git blame + Read offsets).
        const allLines = [
          ...scope.setupLines.map((s) => s.sourceLine),
          ...scope.otherLines.map((o) => o.sourceLine),
          ...scope.ownItBlocks.flatMap((b) => [b.startLine, b.endLine]),
        ];
        const startLine = allLines.length > 0 ? Math.min(...allLines) : scope.node.startPosition.row + 1;
        const endLine = allLines.length > 0 ? Math.max(...allLines) : scope.node.endPosition.row + 1;

        results.push({
          content,
          startLine,
          endLine,
          chunkType: "test",
          symbolId: `${topLevelName}.${scope.name}`,
          name: scope.name,
          parentSymbolId: topLevelName,
        });
      } else if (scope.setupLines.length > 0 || scope.otherLines.length > 0) {
        const content = [...scope.setupLines.map((s) => s.text), ...scope.otherLines.map((o) => o.text)]
          .join("\n")
          .trim();

        if (content.length < 50) return;

        const allLines = [...scope.setupLines.map((s) => s.sourceLine), ...scope.otherLines.map((o) => o.sourceLine)];
        const startLine = allLines.length > 0 ? Math.min(...allLines) : scope.node.startPosition.row + 1;
        const endLine = allLines.length > 0 ? Math.max(...allLines) : scope.node.endPosition.row + 1;

        results.push({
          content,
          startLine,
          endLine,
          chunkType: "test_setup",
          symbolId: `${topLevelName}.${scope.name}`,
          name: scope.name,
          parentSymbolId: topLevelName,
        });
      }
    } else {
      const newAncestors = [...ancestors, scope];
      for (const child of scope.children) {
        walk(child, newAncestors);
      }

      if (scope.ownItBlocks.length > 0) {
        const setupParts = scope.setupLines.map((s) => s.text);
        const otherParts = scope.otherLines.map((o) => o.text);
        const itParts = scope.ownItBlocks.map((b) => b.text);
        const content = [...setupParts, ...otherParts, ...itParts].join("\n").trim();

        if (content.length >= 50) {
          const allLines = [
            ...scope.setupLines.map((s) => s.sourceLine),
            ...scope.otherLines.map((o) => o.sourceLine),
            ...scope.ownItBlocks.flatMap((b) => [b.startLine, b.endLine]),
          ];
          const startLine = allLines.length > 0 ? Math.min(...allLines) : scope.node.startPosition.row + 1;
          const endLine = allLines.length > 0 ? Math.max(...allLines) : scope.node.endPosition.row + 1;

          results.push({
            content,
            startLine,
            endLine,
            chunkType: "test_setup",
            symbolId: `${topLevelName}.${scope.name}`,
            name: scope.name,
            parentSymbolId: topLevelName,
          });
        }
      }
    }
  }

  if (rootScope.isLeaf) {
    walk(rootScope, []);
  } else {
    for (const child of rootScope.children) {
      walk(child, [rootScope]);
    }

    if (rootScope.ownItBlocks.length > 0) {
      const setupParts = rootScope.setupLines.map((s) => s.text);
      const otherParts = rootScope.otherLines.map((o) => o.text);
      const itParts = rootScope.ownItBlocks.map((b) => b.text);
      const content = [...setupParts, ...otherParts, ...itParts].join("\n").trim();

      if (content.length >= 50) {
        const allLines = [
          ...rootScope.setupLines.map((s) => s.sourceLine),
          ...rootScope.otherLines.map((o) => o.sourceLine),
          ...rootScope.ownItBlocks.flatMap((b) => [b.startLine, b.endLine]),
        ];
        const startLine = allLines.length > 0 ? Math.min(...allLines) : rootScope.node.startPosition.row + 1;
        const endLine = allLines.length > 0 ? Math.max(...allLines) : rootScope.node.endPosition.row + 1;

        results.push({
          content,
          startLine,
          endLine,
          chunkType: "test_setup",
          symbolId: `${topLevelName}.${rootScope.name}`,
          name: rootScope.name,
          parentSymbolId: topLevelName,
        });
      }
    }
  }

  return results;
}

// ── Hook export ──────────────────────────────────────────────────────

export const testScopeChunkerHook: ChunkingHook = {
  name: "test-scope-chunker",

  process(ctx: HookContext): void {
    if (!isTestFile(ctx.filePath)) return;
    if (ctx.containerNode.type !== "call_expression") return;
    if (!isDslContainerCall(ctx.containerNode, ctx.code)) return;

    const tree = buildScopeTree(ctx.containerNode, ctx.code);
    const chunks = produceScopeChunks(tree, ctx.code, ctx.config);

    if (chunks.length > 0) {
      ctx.bodyChunks = chunks;
      ctx.skipChildren = true;
    }
  },
};
