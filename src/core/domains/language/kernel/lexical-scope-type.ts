/**
 * A short type name resolved from the caller's LEXICAL scope, the neutral half
 * (bd tea-rags-mcp-2m83f.32.1).
 *
 * A name written inside a namespace means the nearest declaration a lexical
 * lookup reaches — Ruby's `Module.nesting` then the top level, Python's
 * enclosing frames then the module. So `time_entry` inside
 * `GettingPaid::TimeEntriesCsvExporter` is a `GettingPaid::TimeEntry`, not the
 * `Workflow::Pipeline::StageClient::TimeEntry` elsewhere in the corpus.
 *
 * The walk is the whole rule: scopes innermost first, the first scope that
 * declares the name answers. Two declarations at that SAME level are a tie the
 * lookup cannot break, and a tie is silence — never the next scope out, which
 * the nearer declarations shadow.
 */

/** The per-language answers the lookup is composed from. */
export interface LexicalScopeTypePorts<TCtx> {
  /** The caller's lexical scopes, INNERMOST first, the top level last. */
  scopeChain: (ctx: TCtx) => readonly string[];
  /** The qualified types `scope` itself declares under `name`: none, one, or a same-level tie. */
  typesDeclaredIn: (name: string, scope: string, ctx: TCtx) => readonly string[];
}

/** The qualified type `name` reaches from the caller's scope, or `undefined` on a miss or a tie. */
export function nearestScopedTypeName<TCtx>(
  name: string,
  ctx: TCtx,
  ports: LexicalScopeTypePorts<TCtx>,
): string | undefined {
  for (const scope of ports.scopeChain(ctx)) {
    const declared = ports.typesDeclaredIn(name, scope, ctx);
    if (declared.length === 0) continue;
    return declared.length === 1 ? declared[0] : undefined;
  }
  return undefined;
}
