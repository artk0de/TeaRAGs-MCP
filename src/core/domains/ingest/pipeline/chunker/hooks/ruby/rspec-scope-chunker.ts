/**
 * RSpec Scope-Centric Chunker — Groups RSpec specs by scope hierarchy.
 *
 * Instead of treating the entire describe/context body as one flat chunk,
 * this hook walks the AST to build a scope tree and produces focused chunks
 * per leaf scope. Each chunk includes inherited setup (let/before/subject)
 * from ancestor scopes for self-contained context.
 *
 * Chunks get a 2-level symbolId: `TopLevelDescribe.leafScopeName`.
 */

import type Parser from "tree-sitter";

import type { BodyChunkResult, ChunkingHook } from "../types.js";
import { isRspecFile } from "./rspec-filter.js";

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

export interface RSpecScope {
  name: string;
  node: Parser.SyntaxNode;
  isLeaf: boolean;
  setupLines: SetupLine[];
  ownItBlocks: ItBlock[];
  children: RSpecScope[];
  otherLines: SetupLine[];
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

function getCallMethodName(node: Parser.SyntaxNode, code: string): string | null {
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
function extractScopeName(node: Parser.SyntaxNode, code: string): string {
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
function findBlockBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
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

export function buildScopeTree(containerNode: Parser.SyntaxNode, code: string): RSpecScope {
  const codeLines = code.split("\n");
  const scopeName = extractScopeName(containerNode, code);

  const scope: RSpecScope = {
    name: scopeName,
    node: containerNode,
    isLeaf: true,
    setupLines: [],
    ownItBlocks: [],
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
      scope.isLeaf = false;
      for (let { row } = child.startPosition; row <= child.endPosition.row; row++) {
        claimedRows.add(row);
      }
    } else if (EXAMPLE_METHODS.has(methodName)) {
      // Collect it block
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
      // Collect setup lines
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

export function produceScopeChunks(
  rootScope: RSpecScope,
  code: string,
  config: { maxChunkSize: number },
): BodyChunkResult[] {
  const topLevelName = extractTopLevelName(rootScope, code);
  const results: BodyChunkResult[] = [];

  function collectParentSetup(scope: RSpecScope, ancestors: RSpecScope[]): string[] {
    const parts: string[] = [];
    for (const ancestor of ancestors) {
      for (const setup of ancestor.setupLines) {
        parts.push(setup.text);
      }
    }
    return parts;
  }

  function walk(scope: RSpecScope, ancestors: RSpecScope[]): void {
    if (scope.isLeaf) {
      if (scope.ownItBlocks.length > 0) {
        // Leaf with it blocks → test chunk
        const parentSetup = collectParentSetup(scope, ancestors);
        const setupParts = [...parentSetup, ...scope.setupLines.map((s) => s.text)];
        const otherParts = scope.otherLines.map((o) => o.text);
        const itParts = scope.ownItBlocks.map((b) => b.text);

        const contentParts = [...setupParts, ...otherParts, ...itParts];
        const content = contentParts.join("\n").trim();

        if (content.length < 50) return;

        // Check oversized — split by it blocks
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

        // Compute line range from this scope's own lines only.
        // Ancestor setup is included in content for context but should NOT
        // inflate the line range (causes git blame and Read offset issues).
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
        // Leaf without it blocks → test_setup
        const content = [...scope.setupLines.map((s) => s.text), ...scope.otherLines.map((o) => o.text)]
          .join("\n")
          .trim();

        if (content.length < 50) return;

        const allLines = [...scope.setupLines.map((s) => s.sourceLine), ...scope.otherLines.map((o) => o.sourceLine)];
        const startLine = allLines.length > 0 ? Math.min(...allLines) : scope.node.startPosition.row + 1;
        const endLine = allLines.length > 0 ? Math.max(...allLines) : scope.node.endPosition.row + 1;

        // Classify: if setup contains delegating test methods (include_examples,
        // it_behaves_like), these scopes execute actual tests via shared examples.
        const hasDelegatingTests = scope.setupLines.some((s) => {
          for (const method of DELEGATING_TEST_METHODS) {
            if (s.text.includes(method)) return true;
          }
          return false;
        });

        results.push({
          content,
          startLine,
          endLine,
          chunkType: hasDelegatingTests ? "test" : "test_setup",
          symbolId: `${topLevelName}.${scope.name}`,
          name: scope.name,
          parentSymbolId: topLevelName,
        });
      }
    } else {
      // Intermediate scope — recurse into children
      const newAncestors = [...ancestors, scope];
      for (const child of scope.children) {
        walk(child, newAncestors);
      }

      // If intermediate scope has own it blocks, produce test_setup chunk for its setup + it blocks
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

  // For root scope: if it's a leaf itself, process directly
  // Otherwise, walk children with root as ancestor
  if (rootScope.isLeaf) {
    walk(rootScope, []);
  } else {
    // Root is intermediate — its setup flows down to children
    for (const child of rootScope.children) {
      walk(child, [rootScope]);
    }

    // Root's own it blocks (if any)
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
