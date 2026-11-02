/**
 * Keep inline tests out of a walk (plan 2026-11-02 Task 5): tests are out of the
 * codegraph, and for a language whose tests live beside product code (Rust
 * `#[cfg(test)]`, Vitest `if (import.meta.vitest)`) that exclusion has to hold
 * per NODE, not per file.
 *
 * The pruning happens once, at the tree the walk reads: every collector of a
 * walker and every extraction pass traverses `children` / `namedChildren` /
 * field children of the root it is handed, so a root view that hides the
 * test-only subtrees prunes them all — no collector has to know about tests,
 * and a collector added later cannot forget to. The language supplies the
 * recogniser (`<lang>/inline-tests.ts`); this module never knows what a test
 * looks like.
 */

import type { AstNode, MaterializedTree } from "../../../contracts/types/ast.js";
import type { WalkInput } from "../../../contracts/types/language.js";

/** The language's inline-test recognisers the composed walker prunes with. */
export interface InlineTestRecognizers {
  /** True when `node` and its whole subtree exist only in the test build. */
  isInlineTestNode: (node: AstNode, code: string) => boolean;
  /** True when the whole file is test-only (Rust `#![cfg(test)]`). Absent → never. */
  fileIsInlineTestOnly?: (root: AstNode, code: string) => boolean;
}

/** Range + type: stable on native and materialized trees alike (`isSameAstNode`). */
function astNodeKey(node: AstNode): string {
  return `${node.startIndex}:${node.endIndex}:${node.type}`;
}

/** The outermost inline-test nodes under `root` — a hit's own subtree is not searched. */
function collectInlineTestRoots(
  root: AstNode,
  code: string,
  isInlineTestNode: InlineTestRecognizers["isInlineTestNode"],
): AstNode[] {
  const testRoots: AstNode[] = [];
  const visit = (node: AstNode): void => {
    if (isInlineTestNode(node, code)) {
      testRoots.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return testRoots;
}

/**
 * A read-only view of `node` whose subtree hides every node keyed in `pruned`.
 * Children are wrapped lazily and cached per view, so the walker's repeated
 * traversals of one root wrap each visible node once.
 */
class InlineTestPrunedAstNode implements AstNode {
  private visibleChildren?: AstNode[];
  private visibleNamedChildren?: AstNode[];

  constructor(
    private readonly node: AstNode,
    private readonly pruned: ReadonlySet<string>,
  ) {}

  get type(): string {
    return this.node.type;
  }
  get text(): string {
    return this.node.text;
  }
  get startIndex(): number {
    return this.node.startIndex;
  }
  get endIndex(): number {
    return this.node.endIndex;
  }
  get startPosition(): AstNode["startPosition"] {
    return this.node.startPosition;
  }
  get endPosition(): AstNode["endPosition"] {
    return this.node.endPosition;
  }
  get isNamed(): boolean {
    return this.node.isNamed;
  }
  get children(): readonly AstNode[] {
    this.visibleChildren ??= this.visible(this.node.children);
    return this.visibleChildren;
  }
  get namedChildren(): readonly AstNode[] {
    this.visibleNamedChildren ??= this.visible(this.node.namedChildren);
    return this.visibleNamedChildren;
  }
  get childCount(): number {
    return this.children.length;
  }
  get namedChildCount(): number {
    return this.namedChildren.length;
  }
  get parent(): AstNode | null {
    return this.view(this.node.parent);
  }
  get previousNamedSibling(): AstNode | null {
    let sibling = this.node.previousNamedSibling;
    while (sibling && this.pruned.has(astNodeKey(sibling))) sibling = sibling.previousNamedSibling;
    return this.view(sibling);
  }
  child = (index: number): AstNode | null => this.children[index] ?? null;
  namedChild = (index: number): AstNode | null => this.namedChildren[index] ?? null;
  childForFieldName = (field: string): AstNode | null => this.view(this.node.childForFieldName(field));

  private view(node: AstNode | null): AstNode | null {
    if (!node || this.pruned.has(astNodeKey(node))) return null;
    return new InlineTestPrunedAstNode(node, this.pruned);
  }

  private visible(nodes: readonly AstNode[]): AstNode[] {
    return nodes
      .filter((node) => !this.pruned.has(astNodeKey(node)))
      .map((node) => new InlineTestPrunedAstNode(node, this.pruned));
  }
}

/**
 * `input` with its inline tests removed: the tree becomes a view hiding every
 * test-only subtree, and every symbol range lying inside one is dropped, so the
 * walk emits no chunk for it. `null` when the whole file is test-only — there
 * is nothing to walk. A file with no inline test comes back as the SAME input,
 * so its extraction is byte-identical to an unpruned walk.
 */
export function pruneInlineTestSubtrees(input: WalkInput, recognizers: InlineTestRecognizers): WalkInput | null {
  const root = input.tree.rootNode;
  if (recognizers.fileIsInlineTestOnly?.(root, input.code) === true) return null;
  const testRoots = collectInlineTestRoots(root, input.code, recognizers.isInlineTestNode);
  if (testRoots.length === 0) return input;
  const pruned = new Set(testRoots.map(astNodeKey));
  const testLineRanges = testRoots.map((node) => ({
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  }));
  const tree: MaterializedTree = { rootNode: new InlineTestPrunedAstNode(root, pruned) };
  const chunks = input.chunks.filter(
    (chunk) => !testLineRanges.some((range) => chunk.startLine >= range.startLine && chunk.endLine <= range.endLine),
  );
  return { ...input, tree, chunks };
}
