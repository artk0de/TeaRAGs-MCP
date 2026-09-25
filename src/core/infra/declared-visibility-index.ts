/**
 * DeclaredVisibilityIndex — the join half of the declared-visibility
 * decoration (bd tea-rags-mcp-sqqkz). Built from ONE batched
 * `getSymbolVisibilities` read, answered per (relPath, symbolId) for the graph
 * tools and the find_symbol outline.
 *
 * The contract every consumer relies on: an answer is `undefined` whenever the
 * codegraph does not STATE a level — a NULL column, a file or symbol it has no
 * definition for. `undefined` means "omit the field"; nothing here ever
 * defaults to `public`.
 */

import type { DeclaredSymbolVisibility, RelPath, SymbolId, SymbolVisibilityRow } from "../contracts/types/codegraph.js";

export class DeclaredVisibilityIndex {
  static readonly EMPTY = new DeclaredVisibilityIndex(new Map());

  private constructor(
    /** symbolId → relPath → level (null = the walker recorded none). */
    private readonly bySymbol: ReadonlyMap<SymbolId, ReadonlyMap<RelPath, DeclaredSymbolVisibility | null>>,
  ) {}

  static fromRows(rows: readonly SymbolVisibilityRow[]): DeclaredVisibilityIndex {
    const bySymbol = new Map<SymbolId, Map<RelPath, DeclaredSymbolVisibility | null>>();
    for (const row of rows) {
      let byPath = bySymbol.get(row.symbolId);
      if (byPath === undefined) {
        byPath = new Map();
        bySymbol.set(row.symbolId, byPath);
      }
      byPath.set(row.relPath, row.visibility);
    }
    return new DeclaredVisibilityIndex(bySymbol);
  }

  /** True when no definition states a level — decorating would change nothing. */
  get isEmpty(): boolean {
    for (const byPath of this.bySymbol.values()) {
      for (const level of byPath.values()) if (level !== null) return false;
    }
    return true;
  }

  /** The level declared by the definition of `symbolId` in `relPath`. */
  at(relPath: RelPath, symbolId: SymbolId): DeclaredSymbolVisibility | undefined {
    return this.bySymbol.get(symbolId)?.get(relPath) ?? undefined;
  }

  /**
   * The level of a BARE symbolId — answered only when every definition of it
   * (namesakes in other files included) states the same level. Disagreeing or
   * partly-unknown namesakes are unknown as a whole.
   */
  agreedFor(symbolId: SymbolId): DeclaredSymbolVisibility | undefined {
    const byPath = this.bySymbol.get(symbolId);
    if (byPath === undefined) return undefined;
    const levels = new Set(byPath.values());
    if (levels.size !== 1) return undefined;
    const [level] = levels;
    return level ?? undefined;
  }
}
