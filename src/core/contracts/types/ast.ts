/**
 * Plain-JS immutable AST node — the post-parse pipeline's node type. Mirrors the
 * exact subset of `Parser.SyntaxNode` the chunker + walkers use (audited). Because
 * it is a structural SUBSET of SyntaxNode, every SyntaxNode value satisfies AstNode,
 * which lets consumer annotations migrate one at a time. Produced by
 * `materializeTree` in ONE eager pass so native-accessor non-determinism (rdv7d)
 * cannot reach any consumer.
 */
export interface AstNode {
  readonly type: string;
  /** Source slice on demand: code.slice(startIndex, endIndex). Never stored per node. */
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly children: readonly AstNode[];
  readonly namedChildren: readonly AstNode[];
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly isNamed: boolean;
  child: (index: number) => AstNode | null;
  namedChild: (index: number) => AstNode | null;
  childForFieldName: (field: string) => AstNode | null;
  readonly parent: AstNode | null;
  readonly previousNamedSibling: AstNode | null;
}

/**
 * Whether `a` and `b` denote the same syntax node (bd tea-rags-mcp-3hyjt).
 *
 * Never compare nodes with `===`: a NATIVE tree hands out a fresh wrapper per
 * accessor call unless its wrapper cache still holds one, so identity holds or
 * fails with GC timing (rdv7d). A materialized tree happens to be
 * identity-stable, which is why production never saw it — the native-vs-
 * materialized parity test did, intermittently. Range + type is stable on both
 * trees; a parent and a child that span the same bytes differ in type.
 */
export function isSameAstNode(a: AstNode | null | undefined, b: AstNode | null | undefined): boolean {
  if (!a || !b) return false;
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

/** Mirror of the single `Parser.Tree` accessor the pipeline uses. */
export interface MaterializedTree {
  readonly rootNode: AstNode;
}
