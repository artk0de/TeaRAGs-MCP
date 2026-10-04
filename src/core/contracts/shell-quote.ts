/**
 * Shell quoting for rendered remedy commands.
 *
 * Pure string primitive shared by two layers that may not import each other —
 * the drift domain renders `Run:` lines for reindex remedies, the
 * optimizer-recovery contract (bd tea-rags-mcp-89k7k.22) renders the
 * `tea-rags qdrant recover` line — so the foundation is their only legal
 * home. Previously `domains/maintenance/drift/remedy.ts` owned it; the
 * optimizer-recovery render rules moved to `contracts/` (the `resolve-rate`
 * precedent: pure rendering rules over DTO shapes live here and re-export
 * through `api/public`), and contracts imports nothing.
 */

/** Single-quote anything a shell would expand or split; plain words stay bare. */
export function shellQuote(value: string): string {
  return /^[\w./,:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
