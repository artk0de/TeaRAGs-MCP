/**
 * Reading the chunker's split-symbol shape back on the query side.
 *
 * An oversized symbol is indexed as `${base}#part1..#partN`, every part with
 * `parentSymbolId = base` (bd tea-rags-mcp-y5vx4). A part's own rows are its
 * `startLine..endLine`; any content lines above them are the context prefix the
 * chunker prepended (signature + enclosing block openers), so dropping the
 * first `lines - (endLine - startLine + 1)` lines of a part recovers its rows.
 */

/** `foo#part3` with `parentSymbolId: "foo"` → `"foo"`; anything else → undefined. */
export function splitFragmentBase(payload: Record<string, unknown>): string | undefined {
  const symbolId = payload.symbolId as string | undefined;
  const parentSymbolId = payload.parentSymbolId as string | undefined;
  if (!symbolId || !parentSymbolId) return undefined;
  const prefix = `${parentSymbolId}#part`;
  if (!symbolId.startsWith(prefix)) return undefined;
  return /^\d+$/.test(symbolId.slice(prefix.length)) ? parentSymbolId : undefined;
}

/**
 * The container a member symbolId is declared in: everything before its last
 * `#`, `.` or `::` separator (`Acme::User#save` → `Acme::User`, `Foo.bar` →
 * `Foo`). Undefined for a top-level id. A split part's `parentSymbolId` is its
 * symbol, not the class, so an outline reads the class off the symbol id.
 */
export function memberOwnerOf(symbolId: string): string | undefined {
  const match = /^(.*?)(?:#|::|\.)[^#.:]+$/.exec(symbolId);
  return match?.[1] ? match[1] : undefined;
}

/**
 * The rows of a split part without its context prefix: the last
 * `endLine - startLine + 1` lines of its content.
 */
export function splitFragmentOwnRows(payload: Record<string, unknown>): string[] {
  const lines = ((payload.content as string | undefined) ?? "").split("\n");
  const own = Number(payload.endLine) - Number(payload.startLine) + 1;
  if (!Number.isFinite(own) || own <= 0 || own >= lines.length) return lines;
  return lines.slice(lines.length - own);
}
