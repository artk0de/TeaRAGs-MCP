/**
 * Plain same-id redefinition twins (bd tea-rags-mcp-m99j1.1.80).
 *
 * Two `def`s or `class`es that compose ONE symbolId share it by design —
 * alternative defs in `if/else` / `try/except` branches (django
 * `core/files/locks.py`), a nested helper redefined in another branch (flask
 * `View.as_view#view`), a test re-declaring a class or a helper. `collectSymbols`
 * keeps the FIRST range, so a later twin has none, and its body calls fell to
 * whatever chunk enclosed it: an enclosing class chunk (read as "no enclosing
 * class"), an enclosing def of the WRONG frame (a test method, so a twin form's
 * `self` typed as the test case), or no chunk at all for a top-level twin,
 * whose calls were dropped.
 *
 * The pass only LOCATES each twin and the chunk carrying its id; the walker
 * attributes the twin's call sites and def-local channels to that chunk, as it
 * does for property accessor twins. Ids are never minted and chunk ranges never
 * move. The owner is the chunk whose scope EQUALS the twin's scope (the names of
 * its named ancestors, tracked exactly as `collectSymbols` tracks them) and
 * whose id names the twin; a twin with no such chunk, or more than one, answers
 * nothing and keeps its old attribution.
 *
 * A re-declared CLASS joins too. Its non-colliding members already own chunks
 * scoped under the shared class id, and `collectPythonInheritanceEdges` already
 * files its bases under that id, so the shared id is the class the index
 * models; a colliding member's body read through that id is in the same scope
 * as its unique siblings, where it used to read through the enclosing frame.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import { pyNameOf } from "../name-of.js";
import type { PythonSymbolTwinRange } from "./python-property-accessor-twins.js";

/**
 * The chunk shape the pass reads. An owner ENDS before its twin starts: a twin
 * shares the owner's scope, so it is a later sibling, never nested inside it.
 */
interface PythonTwinOwnerCandidate {
  symbolId: string;
  startLine: number;
  endLine: number;
  scope: readonly string[];
}

const SCOPE_JOIN = "\u0000";

/** Does `symbolId` end in the segment `name` (after a `.` / `#` separator, or whole)? */
function idNamesSegment(symbolId: string, name: string): boolean {
  if (symbolId === name) return true;
  if (!symbolId.endsWith(name)) return false;
  const sep = symbolId.charAt(symbolId.length - name.length - 1);
  return sep === "." || sep === "#";
}

/**
 * Every plain same-id twin def / class in the file that has no chunk of its
 * own, with the chunk carrying its id. `claimedStartLines` are twins another
 * pass already attributes (property accessor twins). Empty for a file with no
 * redefinitions.
 */
export function collectPythonRedefinitionTwinRanges(
  root: AstNode,
  chunks: readonly PythonTwinOwnerCandidate[],
  claimedStartLines: ReadonlySet<number>,
): PythonSymbolTwinRange[] {
  const chunkScopeKeysByStart = new Map<number, Set<string>>();
  for (const c of chunks) {
    const key = c.scope.join(SCOPE_JOIN);
    const keys = chunkScopeKeysByStart.get(c.startLine);
    if (keys) keys.add(key);
    else chunkScopeKeysByStart.set(c.startLine, new Set([key]));
  }
  let chunkIndicesByScope: Map<string, number[]> | undefined;
  const ownerOf = (scopeKey: string, name: string, line: number): number | undefined => {
    if (chunkIndicesByScope === undefined) {
      chunkIndicesByScope = new Map();
      chunks.forEach((c, index) => {
        const key = c.scope.join(SCOPE_JOIN);
        const list = chunkIndicesByScope?.get(key);
        if (list) list.push(index);
        else chunkIndicesByScope?.set(key, [index]);
      });
    }
    let owner: number | undefined;
    for (const index of chunkIndicesByScope.get(scopeKey) ?? []) {
      const candidate = chunks[index];
      if (candidate.endLine >= line || !idNamesSegment(candidate.symbolId, name)) continue;
      if (owner !== undefined) return undefined;
      owner = index;
    }
    return owner;
  };

  const twinRanges: PythonSymbolTwinRange[] = [];
  const visit = (node: AstNode, scope: readonly string[]): void => {
    let childScope = scope;
    if (node.type === "function_definition" || node.type === "class_definition") {
      const named = pyNameOf(node);
      if (named) {
        const startLine = node.startPosition.row + 1;
        const scopeKey = scope.join(SCOPE_JOIN);
        if (!chunkScopeKeysByStart.get(startLine)?.has(scopeKey) && !claimedStartLines.has(startLine)) {
          const ownerIndex = ownerOf(scopeKey, named.name, startLine);
          if (ownerIndex !== undefined) twinRanges.push({ ownerIndex, startLine, endLine: node.endPosition.row + 1 });
        }
        childScope = [...scope, named.name];
      }
    }
    for (const child of node.children) visit(child, childScope);
  };
  visit(root, []);
  return twinRanges;
}
