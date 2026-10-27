/**
 * Ruby DSL scope-tree reader — turns a Ruby block DSL call (`describe … do`,
 * `namespace … do`) into the kernel's neutral `TestScope` tree. One reader for
 * every Ruby block DSL (bd tea-rags-mcp-k0602): RSpec and Rake differ only in
 * their `RubyDslScopeVocabulary` — which calls are containers, leaves, setup
 * and descriptions, and how a node names its id segment. Emission is the
 * kernel's (`produceTestScopeChunks`), under the vocabulary the hook passes.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { TestScope } from "../../../../contracts/types/chunker.js";

/** Which calls of a Ruby block DSL play which role in its scope tree. */
export interface RubyDslScopeVocabulary {
  /** Calls whose block is a nested scope (`describe`, `namespace`). */
  containerMethods: ReadonlySet<string>;
  /** Calls that are one leaf of a scope (`it`, `task`). */
  leafMethods: ReadonlySet<string>;
  /** Calls that are a scope's own setup (`let`, `before`). */
  setupMethods: ReadonlySet<string>;
  /** Setup calls that run leaves defined elsewhere (`it_behaves_like`). */
  delegatingSetupMethods: ReadonlySet<string>;
  /** Calls describing the leaf right after them (Rake `desc`): their rows open that leaf. */
  descriptionMethods: ReadonlySet<string>;
  /** Leaf calls whose id no enclosing container scopes (Rake `file`, `rule`). */
  unscopedLeafMethods: ReadonlySet<string>;
  /**
   * Collect the block's rows above its first statement (a leading comment, which
   * tree-sitter parents to the block, not to its body) as other lines too.
   */
  collectRowsAboveBody: boolean;
  /**
   * Non-call declaration node types read as unscoped leaves of a scope, named
   * by `idNameOf` (Rake: a `def` inside a `namespace` keeps its method chunk).
   */
  leafNodeTypes?: ReadonlySet<string>;
  /** The id segment of a container or leaf call, when it is not the display name. */
  idNameOf?: (node: AstNode, code: string) => string | undefined;
}

/** A DSL container read into the kernel's `TestScope`, keeping the call node. */
export interface RubyDslScope extends TestScope {
  node: AstNode;
  children: RubyDslScope[];
}

export function getCallMethodName(node: AstNode, code: string): string | null {
  if (node.type !== "call") return null;
  const id = node.children.find((c) => c.type === "identifier");
  return id ? code.substring(id.startIndex, id.endIndex) : null;
}

/**
 * The display name of a DSL call: its text from the node start to the block
 * opener. `describe User do` → "describe User", `context 'when admin' do` →
 * "context 'when admin'", `RSpec.describe User do` → "RSpec.describe User".
 */
export function extractScopeName(node: AstNode, code: string): string {
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

/** The row of a container call's block opener (`do` / `{`). */
function blockOpenerRow(node: AstNode): number | undefined {
  return node.children.find((c) => c.type === "do_block" || c.type === "block")?.startPosition.row;
}

function claimRows(claimedRows: Set<number>, startRow: number, endRow: number): void {
  for (let row = startRow; row <= endRow; row++) claimedRows.add(row);
}

/** Read one DSL container call, and every container nested in its block, into a scope tree. */
export function readRubyDslScopeTree(
  containerNode: AstNode,
  code: string,
  vocabulary: RubyDslScopeVocabulary,
): RubyDslScope {
  const codeLines = code.split("\n");
  const scopeName = extractScopeName(containerNode, code);
  const scopeIdName = vocabulary.idNameOf?.(containerNode, code);

  const scope: RubyDslScope = {
    name: scopeName,
    node: containerNode,
    startLine: containerNode.startPosition.row + 1,
    endLine: containerNode.endPosition.row + 1,
    setupLines: [],
    examples: [],
    children: [],
    otherLines: [],
    ...(scopeIdName === undefined ? {} : { idName: scopeIdName }),
  };

  const blockBody = findBlockBody(containerNode);
  if (!blockBody) return scope;

  // Track which rows are claimed by recognized child calls
  const claimedRows = new Set<number>();
  // The first row of the description calls waiting for the leaf they describe.
  let descriptionStartRow: number | undefined;

  for (const child of blockBody.namedChildren) {
    if (vocabulary.leafNodeTypes?.has(child.type)) {
      // A declaration, not a DSL call: its own chunk, addressed by its own name.
      const startRow = child.startPosition.row;
      const endRow = child.endPosition.row;
      const idName = vocabulary.idNameOf?.(child, code);
      scope.examples.push({
        name: extractScopeName(child, code),
        text: codeLines.slice(startRow, endRow + 1).join("\n"),
        startLine: startRow + 1,
        endLine: endRow + 1,
        ...(idName === undefined ? {} : { idName }),
        idUnscoped: true,
      });
      claimRows(claimedRows, startRow, endRow);
      descriptionStartRow = undefined;
      continue;
    }
    const methodName = getCallMethodName(child, code);
    if (!methodName) {
      // Not a call node — collect as other lines if non-trivial
      continue;
    }

    if (vocabulary.descriptionMethods.has(methodName)) {
      descriptionStartRow ??= child.startPosition.row;
      continue;
    }

    if (vocabulary.containerMethods.has(methodName)) {
      // Recurse into nested container
      scope.children.push(readRubyDslScopeTree(child, code, vocabulary));
      claimRows(claimedRows, child.startPosition.row, child.endPosition.row);
    } else if (vocabulary.leafMethods.has(methodName)) {
      // A leaf — named like a scope, by its call up to the block opener
      // (`it 'returns nil'`, `its(:email)`); a one-line brace block keeps its
      // whole line, the only description a description-less example has. A
      // description call above it opens it.
      const startRow = descriptionStartRow ?? child.startPosition.row;
      const endRow = child.endPosition.row;
      const idName = vocabulary.idNameOf?.(child, code);
      scope.examples.push({
        name: extractScopeName(child, code),
        text: codeLines.slice(startRow, endRow + 1).join("\n"),
        startLine: startRow + 1,
        endLine: endRow + 1,
        ...(idName === undefined ? {} : { idName }),
        ...(vocabulary.unscopedLeafMethods.has(methodName) ? { idUnscoped: true } : {}),
      });
      claimRows(claimedRows, startRow, endRow);
    } else if (vocabulary.setupMethods.has(methodName)) {
      // Collect setup lines
      const startRow = child.startPosition.row;
      const endRow = child.endPosition.row;
      scope.setupLines.push({
        text: codeLines.slice(startRow, endRow + 1).join("\n"),
        sourceLine: startRow + 1,
        ...(vocabulary.delegatingSetupMethods.has(methodName) ? { delegatesExamples: true } : {}),
      });
      claimRows(claimedRows, startRow, endRow);
    }
    // A description no leaf follows stays unclaimed: it reads as other lines.
    descriptionStartRow = undefined;
  }

  // Collect remaining non-blank lines as otherLines
  // body_statement range covers the actual body content (no do/end wrapper)
  const opener = vocabulary.collectRowsAboveBody ? blockOpenerRow(containerNode) : undefined;
  const bodyStartRow = opener === undefined ? blockBody.startPosition.row : opener + 1;
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
