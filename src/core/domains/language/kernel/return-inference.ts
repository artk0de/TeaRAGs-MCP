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
 *  4. Two arms naming different types kill it too — UNLESS the language opts
 *     into a {@link ReturnUnionPolicy} (bd tea-rags-mcp-m99j1.1.53). Then the
 *     arms' names are collected as a union, in declaration order and deduped,
 *     and a union wider than `maxArms` kills. The engine still never JOINS to
 *     an ancestor: a subtype arm stays beside its base, because an override on
 *     the subtype is a different target. Under the policy rule 2 also accepts
 *     SEVERAL plain events (one per branch); every one must map, and the
 *     language reports an event a later unconditional rebinding overwrites as
 *     `null` — that is its knowledge of control flow, not the engine's.
 *
 * Without the policy (Ruby) the result is byte-identical to the single-type
 * engine: one name, or silence.
 */

/** What one expression names: one nominal, or — for a language whose own lookups already fold unions — several. */
export type ReturnArmTypes = string | readonly string[];

/** A language's opt-in to rule 4's union form. Absent ⇒ two different types kill. */
export interface ReturnUnionPolicy {
  /** The widest union the language will publish; a wider one is silence. */
  readonly maxArms: number;
}

export interface ReturnInferencePorts<TNode, TCtx> {
  /** The expressions whose value the def yields. Empty ⇒ no inference. */
  terminalExpressions: (defNode: TNode, ctx: TCtx) => readonly TNode[];
  /** The nominal type name(s) an expression evaluates to, or `null` when not statically known. */
  typeOfExpression: (node: TNode, ctx: TCtx) => ReturnArmTypes | null;
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
 * The nominal types a def returns — one name, or under a {@link ReturnUnionPolicy}
 * up to `maxArms` names in declaration order — or `null` (silence). See the
 * rules on {@link ReturnInferencePorts}.
 */
export function inferReturnTypeNames<TNode, TCtx>(
  defNode: TNode,
  ctx: TCtx,
  ports: ReturnInferencePorts<TNode, TCtx>,
  union?: ReturnUnionPolicy,
): readonly string[] | null {
  const terminals = ports.terminalExpressions(defNode, ctx);
  if (terminals.length === 0) return null;
  const maxArms = union?.maxArms ?? 1;
  const names: string[] = [];
  for (const terminal of terminals) {
    const arm = armTypeNames(defNode, terminal, ctx, ports, union !== undefined);
    if (arm === null) return null;
    for (const name of arm) {
      if (names.includes(name)) continue;
      if (names.length === maxArms) return null;
      names.push(name);
    }
  }
  return names;
}

/**
 * The single nominal type a def returns, or `null` (silence) — the engine
 * without a union policy, which is what Ruby runs.
 */
export function inferReturnTypeName<TNode, TCtx>(
  defNode: TNode,
  ctx: TCtx,
  ports: ReturnInferencePorts<TNode, TCtx>,
): string | null {
  return inferReturnTypeNames(defNode, ctx, ports)?.[0] ?? null;
}

/** A port answer as a list; an empty list is no answer. */
function armNames(typed: ReturnArmTypes | null): readonly string[] | null {
  if (typed === null) return null;
  if (typeof typed === "string") return [typed];
  return typed.length === 0 ? null : typed;
}

/**
 * One terminal arm's types: direct, or one hop through its plain assignment —
 * exactly one without a union policy, every one (each mapped) with it.
 */
function armTypeNames<TNode, TCtx>(
  defNode: TNode,
  terminal: TNode,
  ctx: TCtx,
  ports: ReturnInferencePorts<TNode, TCtx>,
  widen: boolean,
): readonly string[] | null {
  if (!ports.isBinding(terminal)) return armNames(ports.typeOfExpression(terminal, ctx));
  const events = ports.assignmentEvents(defNode, ports.bindingName(terminal), ctx);
  if (events.length === 0) return null; // a method-call tail
  if (events.length > 1 && !widen) return null; // reassigned
  const names: string[] = [];
  for (const rhs of events) {
    if (rhs === null || ports.isBinding(rhs)) return null; // non-plain event, or a second binding hop
    const typed = armNames(ports.typeOfExpression(rhs, ctx));
    if (typed === null) return null;
    names.push(...typed);
  }
  return names;
}
