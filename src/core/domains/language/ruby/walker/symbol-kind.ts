/**
 * Ruby declaration node → `SymbolDefinitionKind` (bd tea-rags-mcp-vi0wx).
 *
 * Ruby has no interfaces, enums, type aliases or free functions: a top-level
 * `def` is a private method on `Object`, and every DSL macro that declares
 * anything (`attr_reader`, `has_many`, `define_method`, `alias`, …) declares a
 * METHOD. So the vocabulary collapses to class / module / method / constant.
 *
 * `symbolKindOf` is the pure mapping; `rubyChunkSymbolKinds` finds, for each
 * chunk, the node that declared it and asks the mapping.
 *
 * Constants are NOT new symbols here: `rbNameOf` declares none, so a `MAX = 3`
 * gets a kind only when a caller hands the walker a chunk for it. Emitting one
 * from `rbNameOf` would add a chunk range that takes ownership of every call in
 * its right-hand side (`assignCallsToInnermostChunks`) — a `CONST = {…}.freeze`
 * dispatch table would move its edges off the class — so it is a resolution
 * change, not a tag.
 *
 * Two facts the node type alone cannot carry arrive in `context`, both decided
 * by the caller from the node itself: whether a macro-shaped node (`call`, bare
 * `identifier`, `alias`) actually declares a method, and whether an
 * `assignment` targets a constant (`MAX = 3`) rather than a local.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import type { RubyDslCatalogue } from "../dsl/index.js";
import { walk } from "./ast-utils.js";
import { rbNameOf } from "./name-of.js";

export interface RubySymbolKindContext {
  /** The node declares a method through a DSL macro or the `alias` keyword. */
  readonly declaresMethod: boolean;
  /** The node is an assignment whose left-hand side is a constant. */
  readonly assignsConstant: boolean;
}

const STRUCTURAL_KINDS: Readonly<Record<string, SymbolDefinitionKind>> = {
  class: "class",
  module: "module",
  method: "method",
  singleton_method: "method",
};

export function symbolKindOf(nodeType: string, context: RubySymbolKindContext): SymbolDefinitionKind | undefined {
  const structural = STRUCTURAL_KINDS[nodeType];
  if (structural !== undefined) return structural;
  if (context.declaresMethod) return "method";
  if (nodeType === "assignment" && context.assignsConstant) return "constant";
  return undefined;
}

/** The chunk shape the kind lookup reads — a subset of `RubyExtractInput.chunks`. */
interface RubyChunkRange {
  readonly symbolId: string;
  readonly startLine: number;
  readonly endLine: number;
}

const rangeKey = (startLine: number, endLine: number): string => `${startLine}:${endLine}`;

/**
 * Whether `symbolId` is the id composed for `name` — the last segment, joined
 * by the separator its `methodKind` selects (`#` / `.` for a method, `::` for a
 * namespace or constant), or the bare name at top level.
 */
function composesTo(symbolId: string, name: string, methodKind: NamedSymbol["methodKind"]): boolean {
  if (symbolId === name) return true;
  if (methodKind !== undefined) return symbolId.endsWith(`#${name}`) || symbolId.endsWith(`.${name}`);
  return symbolId.endsWith(`::${name}`);
}

/** The constant an `assignment` targets (`MAX = 3`, `A::MAX = 3`), or undefined for any other target. */
function assignedConstantName(node: AstNode): string | undefined {
  const left = node.childForFieldName("left");
  if (left?.type === "constant") return left.text;
  if (left?.type === "scope_resolution") {
    const name = left.childForFieldName("name");
    if (name?.type === "constant") return name.text;
  }
  return undefined;
}

/** The kind `node` declares under `symbolId`, or undefined when it declares something else. */
function kindDeclaredAs(
  node: AstNode,
  symbolId: string,
  catalogue: RubyDslCatalogue,
): SymbolDefinitionKind | undefined {
  if (node.type === "assignment") {
    const constant = assignedConstantName(node);
    if (constant === undefined || !composesTo(symbolId, constant, undefined)) return undefined;
    return symbolKindOf(node.type, { declaresMethod: false, assignsConstant: true });
  }
  const named = rbNameOf(node, catalogue);
  if (named === null) return undefined;
  const emissions = Array.isArray(named) ? named : [named];
  if (!emissions.some((ns) => composesTo(symbolId, ns.name, ns.methodKind))) return undefined;
  // `rbNameOf` answers non-null only for class / module / def nodes and for the
  // macro and `alias` nodes that declare a method.
  return symbolKindOf(node.type, { declaresMethod: true, assignsConstant: false });
}

/**
 * The declaration kind of each chunk, in `chunks` order. A chunk carries only a
 * line range and a symbolId, so the declaring node is recovered from the tree:
 * a node spanning exactly the chunk's lines whose own name composes to the
 * chunk's symbolId. Matching the NAME, not just the range, is what tells a
 * one-line `class B; def c; end; end` apart from the `def` sharing its line.
 * A chunk no declaration matches stays undefined — the walker never guesses.
 */
export function rubyChunkSymbolKinds(
  root: AstNode,
  chunks: readonly RubyChunkRange[],
  catalogue: RubyDslCatalogue,
): (SymbolDefinitionKind | undefined)[] {
  const wanted = new Set(chunks.map((c) => rangeKey(c.startLine, c.endLine)));
  const nodesByRange = new Map<string, AstNode[]>();
  if (wanted.size > 0) {
    walk(root, (node) => {
      const key = rangeKey(node.startPosition.row + 1, node.endPosition.row + 1);
      if (!wanted.has(key)) return;
      const bucket = nodesByRange.get(key);
      if (bucket) bucket.push(node);
      else nodesByRange.set(key, [node]);
    });
  }
  return chunks.map((c) => {
    for (const node of nodesByRange.get(rangeKey(c.startLine, c.endLine)) ?? []) {
      const kind = kindDeclaredAs(node, c.symbolId, catalogue);
      if (kind !== undefined) return kind;
    }
    return undefined;
  });
}
