import type Parser from "tree-sitter";

import type { AstNode } from "../contracts/types/ast.js";

/** Concrete immutable node. `text` slices the shared `code` lazily (no per-node strings). */
class MaterializedNode implements AstNode {
  readonly children: AstNode[] = [];
  readonly namedChildren: AstNode[] = [];
  parent: AstNode | null = null;
  previousNamedSibling: AstNode | null = null;
  /**
   * Field children, allocated on the first one (bd tea-rags-mcp-1v12o.2.4).
   * Most nodes in a tree-sitter parse have no field child at all — identifiers,
   * operators, punctuation, every literal — so an eager `new Map()` per node was
   * the largest avoidable share of the ~350 B a materialized node costs, on
   * trees that run to millions of nodes. Private: nothing outside this file has
   * ever read it, and `AstNode` exposes only `childForFieldName`.
   */
  private fieldsMap: Map<string, AstNode> | undefined;
  isNamed = false;
  constructor(
    readonly type: string,
    readonly startIndex: number,
    readonly endIndex: number,
    readonly startPosition: { row: number; column: number },
    readonly endPosition: { row: number; column: number },
    private readonly code: string,
  ) {}
  get text(): string {
    return this.code.slice(this.startIndex, this.endIndex);
  }
  get childCount(): number {
    return this.children.length;
  }
  get namedChildCount(): number {
    return this.namedChildren.length;
  }
  child(i: number): AstNode | null {
    return this.children[i] ?? null;
  }
  namedChild(i: number): AstNode | null {
    return this.namedChildren[i] ?? null;
  }
  childForFieldName(field: string): AstNode | null {
    return this.fieldsMap?.get(field) ?? null;
  }
  /** First writer for a field name wins, exactly as the eager `has` guard did. */
  setFieldChild(field: string, child: AstNode): void {
    const map = (this.fieldsMap ??= new Map<string, AstNode>());
    if (!map.has(field)) map.set(field, child);
  }
}

/**
 * Materialize a native tree into an immutable plain-JS AstNode in ONE eager pass.
 * Uses native child(i) + fieldNameForChild(i) + isNamed — all confirmed present
 * in the installed node-tree-sitter binding (tree-sitter.d.ts audited). The
 * eager one-touch-per-node capture is deterministic (DECIDER finding).
 *
 * Lives in `infra/` so both `domains/ingest` (chunker) and `domains/trajectory`
 * (codegraph extractOneFile) can import it without a domain-boundary violation.
 */
export function materializeTree(nativeRoot: Parser.SyntaxNode, code: string): AstNode {
  const build = (native: Parser.SyntaxNode, parent: MaterializedNode | null): MaterializedNode => {
    const node = new MaterializedNode(
      native.type,
      native.startIndex,
      native.endIndex,
      { row: native.startPosition.row, column: native.startPosition.column },
      { row: native.endPosition.row, column: native.endPosition.column },
      code,
    );
    node.parent = parent;
    let prevNamed: MaterializedNode | null = null;
    const { childCount } = native;
    for (let i = 0; i < childCount; i++) {
      const nativeChild = native.child(i);
      if (nativeChild === null) continue;
      // Read ALL native accessors for index `i` BEFORE descending into the
      // subtree — the proven eager single-touch ordering (rdv7d). Late access
      // after the recursive `build()` (which creates+drops many wrappers and
      // may trigger GC) is the exact pattern the materializer exists to avoid.
      const childIsNamed = nativeChild.isNamed;
      const field = native.fieldNameForChild(i);
      const child = build(nativeChild, node);
      child.isNamed = childIsNamed;
      node.children.push(child);
      if (childIsNamed) {
        child.previousNamedSibling = prevNamed;
        node.namedChildren.push(child);
        prevNamed = child;
      }
      if (field) node.setFieldChild(field, child);
    }
    return node;
  };
  return build(nativeRoot, null);
}
