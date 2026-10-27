/**
 * SymbolId string surgery for the places that must take a symbolId apart instead of
 * matching it whole (DuckDB codegraph reads, the graph facade, the codegraph domain):
 * inheritance-driven poly-base expansion (`splitMethodSymbol`) and the
 * `findSymbolChunk` last-segment fallback (`lastNameSegment`).
 *
 * Both follow `.claude/rules/symbolid-convention.md`: `#` (instance) and `.`
 * (static) are member boundaries, `::` is a namespace separator.
 */

import type { SymbolId } from "../../../contracts/types/codegraph.js";

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

/**
 * The owner a qualified symbolId names: everything before its trailing name
 * segment, without the separator (`Acme::User#save` → `Acme::User`,
 * `Foo.bar` → `Foo`). Empty for a bare name.
 */
export function qualifiedOwnerOf(symbol: string): string {
  const tail = lastNameSegment(symbol);
  return symbol.slice(0, symbol.length - tail.length).replace(/(?:[#.]|::)$/, "");
}

/**
 * Whether `candidate` lies under `owner` at a segment boundary — `owner::…`,
 * `owner.…` or `owner#…`, never a mere string prefix (`Acc` does not own
 * `Account#x`). The rule a qualified find_symbol request keeps its owner by
 * (bd tea-rags-mcp-ll0s8, q1g6s.15): a same-tail match under another owner is
 * never an answer.
 */
export function isUnderOwner(candidate: string, owner: string): boolean {
  return ["::", ".", "#"].some((separator) => candidate.startsWith(`${owner}${separator}`));
}
