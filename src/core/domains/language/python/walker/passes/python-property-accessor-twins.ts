/**
 * Property accessor twins (bd tea-rags-mcp-m99j1.1.76).
 *
 * `@property def x` and `@x.setter def x` / `@x.deleter def x` / `@x.getter
 * def x` compose ONE symbolId, `Cls#x`, by design: an accessor pair is one
 * member, and chunk ids and `find_symbol` rely on the shared id. `collectSymbols`
 * keeps the first range, so the getter owns the chunk and every later accessor
 * def has no range of its own. Without this pass a twin's body calls fell
 * through to the enclosing CLASS chunk, whose `scope` is the class's
 * declaration scope — read by the resolver as "no enclosing class" — and
 * `self.<field>.<member>()` in a setter never resolved while the same call in
 * the getter did (django `contrib/gis/geos/point.py`).
 *
 * The pass only LOCATES the twins; the walker attributes their call sites and
 * def-local channels to the owning chunk. Only the accessor decorator shape
 * qualifies: a plain same-named redefinition (conditional `if/else` defs,
 * sequentially redefined test helpers) can be a genuinely different body with a
 * different signature, and an `@overload` group already yields its symbol to
 * the implementation in `pyNameOf`.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";

/**
 * A same-id twin def's (or class's) own line range — a property accessor twin
 * here, a plain redefinition in `python-redefinition-twins.ts` — owned by the
 * chunk at `ownerIndex`, which carries the shared symbolId.
 */
export interface PythonSymbolTwinRange {
  ownerIndex: number;
  startLine: number;
  endLine: number;
}

/** `@x.setter` / `@x.deleter` / `@x.getter` — captures the property name. */
const ACCESSOR_DECORATOR = /^@\s*([A-Za-z_]\w*)\s*\.\s*(?:setter|deleter|getter)$/;

function defName(fn: AstNode): string | undefined {
  return fn.childForFieldName("name")?.text;
}

function undecorated(node: AstNode): AstNode {
  return node.type === "decorated_definition" ? (node.childForFieldName("definition") ?? node) : node;
}

/** Is `fn` decorated as an accessor of the property it is itself named after? */
function isAccessorOfItself(fn: AstNode, name: string): boolean {
  const { parent } = fn;
  if (parent?.type !== "decorated_definition") return false;
  return parent.children.some((c) => c.type === "decorator" && ACCESSOR_DECORATOR.exec(c.text.trim())?.[1] === name);
}

/**
 * The chunk owning `fn`'s symbolId: the nearest EARLIER same-named sibling def
 * that has a chunk of its own, whose id is the instance member `…#name` — the
 * id an undecorated-kind accessor composes. Anything else (no earlier def, a
 * static/class-level twin) answers nothing.
 */
function owningChunkIndex(
  fn: AstNode,
  name: string,
  chunkIndexByStart: ReadonlyMap<number, number>,
  chunks: readonly { symbolId: string }[],
): number | undefined {
  const container = fn.parent?.parent;
  if (!container) return undefined;
  const fnStart = fn.startPosition.row;
  let owner: number | undefined;
  for (const sibling of container.children) {
    if (sibling.startPosition.row >= fnStart) break;
    const candidate = undecorated(sibling);
    if (candidate.type !== "function_definition" || defName(candidate) !== name) continue;
    const index = chunkIndexByStart.get(candidate.startPosition.row + 1);
    if (index !== undefined) owner = index;
  }
  if (owner === undefined || !chunks[owner].symbolId.endsWith(`#${name}`)) return undefined;
  return owner;
}

/**
 * Every accessor twin def in the file that has no chunk of its own, with the
 * chunk owning the property's shared symbolId. Empty for a file with no
 * accessor pairs.
 */
export function collectPythonAccessorTwinRanges(
  root: AstNode,
  chunks: readonly { symbolId: string; startLine: number }[],
): PythonSymbolTwinRange[] {
  const chunkIndexByStart = new Map<number, number>();
  chunks.forEach((c, index) => {
    if (!chunkIndexByStart.has(c.startLine)) chunkIndexByStart.set(c.startLine, index);
  });
  const twinRanges: PythonSymbolTwinRange[] = [];
  const visit = (node: AstNode): void => {
    if (node.type === "function_definition") {
      const name = defName(node);
      const startLine = node.startPosition.row + 1;
      if (name !== undefined && !chunkIndexByStart.has(startLine) && isAccessorOfItself(node, name)) {
        const ownerIndex = owningChunkIndex(node, name, chunkIndexByStart, chunks);
        if (ownerIndex !== undefined) twinRanges.push({ ownerIndex, startLine, endLine: node.endPosition.row + 1 });
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return twinRanges;
}
