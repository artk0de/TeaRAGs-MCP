/**
 * The language-neutral half of return-type inference (E2 seam 5, bd
 * tea-rags-mcp-9fgdi) — relocated from
 * `ruby/walker/type-sources/body-last-expr.ts`, whose Ruby-specific mapping
 * (`Const.new`, `.freeze`/`.tap` passthrough, `is_a?` coercion ternaries, the
 * Gemfile catalogue) stayed behind as ports.
 *
 * Four rules, and they are the whole precision story:
 *
 *  1. EVERY terminal expression is mapped. Ruby hands one (the body's last
 *     expression); Python hands N (one per `return` statement). A def with no
 *     terminal expression at all infers nothing.
 *  2. A terminal that is a BARE BINDING (a local, a Ruby `@ivar`) indirects
 *     through its assignment events inside the same body and needs EXACTLY one
 *     PLAIN event — zero means the value came from somewhere the body cannot
 *     see, more than one means it was reassigned, and a `null` event is the
 *     language reporting an operator- or multiple-assignment it will not vouch
 *     for. Indirection is ONE hop: a binding assigned from another binding is
 *     silence, not a second lookup.
 *  3. An arm that maps to nothing kills the whole inference. A def that returns
 *     `Foo` on one branch and an opaque call on another has no single type,
 *     and guessing `Foo` would poison every downstream chain hop.
 *  4. Two arms naming different types kill it too. This is the union rule
 *     stated where it is cheapest: the engine never widens.
 */
export interface ReturnInferencePorts<TNode, TCtx> {
  /** The expressions whose value the def yields. Empty ⇒ no inference. */
  terminalExpressions: (defNode: TNode, ctx: TCtx) => readonly TNode[];
  /** The nominal type name an expression evaluates to, or `null` when not statically known. */
  typeOfExpression: (node: TNode, ctx: TCtx) => string | null;
  /** Is this node a bare name binding whose assignment should be consulted? */
  isBinding: (node: TNode) => boolean;
  /** The name a binding node carries. */
  bindingName: (node: TNode) => string;
  /**
   * One entry per assignment EVENT to `name` inside `defNode`, in source order.
   * A plain `name = EXPR` carries its RHS; every event the language will not
   * vouch for (operator assignment, multiple-assignment target, augmented
   * target) carries `null`.
   */
  assignmentEvents: (defNode: TNode, name: string, ctx: TCtx) => readonly (TNode | null)[];
}

/**
 * The single nominal type a def returns, or `null` (silence). See the rules on
 * {@link ReturnInferencePorts}.
 */
export function inferReturnTypeName<TNode, TCtx>(
  defNode: TNode,
  ctx: TCtx,
  ports: ReturnInferencePorts<TNode, TCtx>,
): string | null {
  const terminals = ports.terminalExpressions(defNode, ctx);
  if (terminals.length === 0) return null;
  let agreed: string | null = null;
  for (const terminal of terminals) {
    const name = armTypeName(defNode, terminal, ctx, ports);
    if (name === null) return null;
    if (agreed === null) agreed = name;
    else if (agreed !== name) return null;
  }
  return agreed;
}

/** One terminal arm's type: direct, or one hop through a single plain assignment. */
function armTypeName<TNode, TCtx>(
  defNode: TNode,
  terminal: TNode,
  ctx: TCtx,
  ports: ReturnInferencePorts<TNode, TCtx>,
): string | null {
  if (!ports.isBinding(terminal)) return ports.typeOfExpression(terminal, ctx);
  const events = ports.assignmentEvents(defNode, ports.bindingName(terminal), ctx);
  if (events.length !== 1) return null; // 0 = method-call tail; >1 = reassigned
  const rhs = events[0];
  if (rhs === null || ports.isBinding(rhs)) return null; // non-plain event, or a second binding hop
  return ports.typeOfExpression(rhs, ctx);
}
