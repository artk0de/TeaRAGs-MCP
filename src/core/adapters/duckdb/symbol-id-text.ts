/**
 * SymbolId string surgery used by the DuckDB codegraph reads — the two places
 * this adapter has to take a symbolId apart instead of matching it whole:
 * inheritance-driven poly-base expansion (`splitMethodSymbol`) and the
 * `findSymbolChunk` last-segment fallback (`lastNameSegment`).
 *
 * Both follow `.claude/rules/symbolid-convention.md`: `#` (instance) and `.`
 * (static) are member boundaries, `::` is a namespace separator.
 */

import type { SymbolId } from "../../contracts/types/codegraph.js";

/**
 * Split a method symbolId into its declaring type, the class↔member separator,
 * and the member (bd tea-rags-mcp-2jet-E). Per `symbolid-convention.md` the
 * separator between class and member is `#` (instance) or `.` (static); `::`
 * (Ruby/Rust namespace) is NOT a member boundary. The LAST `#` wins when
 * present (so `Acme::User#save` → base `Acme::User`, member `save`); otherwise
 * fall back to the last `.`. Returns `null` for a bare top-level symbol with no
 * member separator — nothing to expand.
 *
 * Exported for the GraphFacade's lazy ambiguous expansion (bd f2jsb A4): the
 * `includeAmbiguous` read extracts the target's member segment with the same
 * convention this adapter persists `cg_ambiguous_fanout.member` under.
 */
export function splitMethodSymbol(symbolId: SymbolId): { base: string; sep: "#" | "."; member: string } | null {
  const hash = symbolId.lastIndexOf("#");
  if (hash > 0 && hash < symbolId.length - 1) {
    return { base: symbolId.slice(0, hash), sep: "#", member: symbolId.slice(hash + 1) };
  }
  const dot = symbolId.lastIndexOf(".");
  if (dot > 0 && dot < symbolId.length - 1) {
    return { base: symbolId.slice(0, dot), sep: ".", member: symbolId.slice(dot + 1) };
  }
  return null;
}

/**
 * Trailing name segment of a symbolId — the part after the final structural
 * separator (`#` instance, `.` static, `::` namespace; see
 * `.claude/rules/symbolid-convention.md`). Ruby method-name suffixes (`?!=`) are
 * preserved (`Foo#valid?` → `valid?`). A bare name with no separator is returned
 * unchanged. Used by the `findSymbolChunk` last-segment fallback (mtlhd).
 */
export function lastNameSegment(symbol: string): string {
  const parts = symbol.split(/[#.]|::/);
  return parts[parts.length - 1] ?? symbol;
}
