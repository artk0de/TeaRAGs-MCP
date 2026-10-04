/**
 * Declared visibility on find_symbol outline lines (bd tea-rags-mcp-sqqkz).
 *
 * Outlines are built from the Qdrant payload, which carries no visibility; the
 * level lives in the codegraph (`cg_symbols.visibility`). Rendering stays a
 * pure function of its chunks, so the join runs in two passes over it:
 *
 *   1. render with a RECORDING lookup — it answers "unknown" for everything
 *      and collects the symbolIds the renderer actually put on a member line.
 *      Nothing recorded (a method body, a doc section) → done, no read at all.
 *   2. one batched codegraph read for exactly those ids, then render again with
 *      the answers. Rendering is pure and cheap; a second pass costs less than
 *      re-deriving which chunks become outline lines.
 *
 * No resolver (codegraph off), a read that throws (graph unreadable), or a
 * graph that states no level → the first render goes out unchanged. The
 * outline never fails because the decoration did. On a working tree the read
 * goes to the tree graph when `readTreeGraph` answers `built` (WTO-7), so a
 * member the tree added or re-declared is decorated as the tree states it.
 */

import type { SymbolVisibilityResolver } from "../../contracts/types/codegraph.js";
import type { WorkingTreeGraphReader } from "../../contracts/types/working-tree.js";
import { DeclaredVisibilityIndex } from "../../infra/declared-visibility-index.js";
import type { MemberVisibilityLookup } from "./chunk-grouping/types.js";

export async function renderWithDeclaredVisibility<T>(
  render: (visibilityOf?: MemberVisibilityLookup) => T,
  resolver: SymbolVisibilityResolver | undefined,
  collectionName: string,
  readTreeGraph?: WorkingTreeGraphReader,
): Promise<T> {
  if (resolver === undefined) return render();
  const requested = new Set<string>();
  const plain = render((_relativePath, symbolId) => {
    requested.add(symbolId);
    return undefined;
  });
  if (requested.size === 0) return plain;
  let index: DeclaredVisibilityIndex;
  try {
    index = DeclaredVisibilityIndex.fromRows(
      readTreeGraph
        ? await resolver.resolveSymbolVisibilities(collectionName, [...requested], readTreeGraph)
        : await resolver.resolveSymbolVisibilities(collectionName, [...requested]),
    );
  } catch {
    return plain;
  }
  if (index.isEmpty) return plain;
  return render((relativePath, symbolId) => index.at(relativePath, symbolId));
}
