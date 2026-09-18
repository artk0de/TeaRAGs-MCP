/**
 * Flow-sensitive local-variable typing — one position-aware binding
 * (`LocalBinding`) plus the two lookups that read a variable's most-recent
 * binding at a call's line. Carried on `ChunkExtraction.localBindings` at
 * extraction time and on `CallContext.localBindings` at resolve time, which is
 * why it sits below both rather than inside either.
 *
 * The lookups live here, not in each language's resolver, so "most recent
 * binding at or before this line" is defined exactly once. Re-exported verbatim
 * by the `codegraph.ts` barrel.
 */

import type { RubyTypeRef } from "./language.js";

/**
 * A single position-aware local-variable type binding: the variable's inferred
 * receiver type, tagged with the 1-based source line where the binding is
 * established. A variable accumulates an array of these (one per assignment /
 * annotation on its path); a call site resolves against the most-recent binding
 * at or before its own line via {@link resolveLocalBindingType}. This makes
 * `var.method()` resolution flow-sensitive — a reassignment to a different type
 * is the correct answer per call site, not a conflict.
 */
export interface LocalBinding {
  /** 1-based source line where this binding is established. */
  line: number;
  /** Inferred receiver type (class / constant name), e.g. "User" or "Acme::Post". */
  type: string;
  /**
   * Whether `type` is held as a CLASS (`var = User` → `var.find` resolves
   * `User.find`, a static method) or an INSTANCE (default; `var = User.new` →
   * `var.save` resolves `User#save`). Absent ⇒ `"instance"` so every existing
   * binding and every other language is unaffected (bd Increment B / var=CONST).
   */
  valueKind?: "instance" | "class";
  /**
   * Richer receiver type when the bare `type` string can't represent it (union /
   * container); engine prefers `typeRef` when present. Added by INFRA-A so
   * union (`[A,B]`) and container (`Array<Post>`) receiver types ride the
   * EXISTING localBindings channel to the propagation engine at resolve time.
   * Absent for plain class/instance bindings (the string `type` is sufficient).
   */
  typeRef?: RubyTypeRef;
  /**
   * 1-based last line of the STATEMENT that establishes this binding — `line`
   * for a single-line one, the closing line of a multi-line right-hand side
   * otherwise (bd tea-rags-mcp-w205u, E4.6a).
   *
   * Python evaluates a right-hand side BEFORE it rebinds the name, so inside
   * `line..endLine` the variable still denotes whatever it denoted above the
   * statement. netbox's `layout = layout.Layout(\n    layout.Row(…))` is that
   * shape: the inner receivers name the imported MODULE, not the class being
   * constructed. Only a consumer that knows the extent can say so. Go's
   * walker sets it on the locals a statement declares (Go scopes them from
   * the statement's END), and Go reads it through `goLocalBindingAt`.
   *
   * ABSENT means "unknown, treat as `line`" — every index written before this
   * field existed, and every binding that is not an establishing statement
   * (a `def` parameter hint records none).
   */
  endLine?: number;
  /**
   * 1-based LAST line the binding is visible on — for a binding scoped to a
   * block narrower than the chunk (bd tea-rags-mcp-e6xx: a Go function
   * literal's parameter, which shadows its name for the literal's lines only).
   * Past it the lookups skip the binding, so the name denotes whatever it
   * denoted before the block, or nothing.
   *
   * Not {@link LocalBinding.endLine}, which is where the ESTABLISHING statement
   * ends. ABSENT means visible to the end of the chunk — every binding every
   * other language records.
   */
  scopeEndLine?: number;
}

/**
 * Resolve the most-recent local binding for `varName` at or before `atLine`
 * (the binding with the greatest `line <= atLine`). Returns undefined when the
 * variable has no binding established on or before that line — the resolver then
 * falls through (no local type), preserving the DROP-not-guess discipline.
 *
 * Shared by every language's local-binding resolver AND the language-neutral
 * cone dispatcher so the position-aware lookup is defined exactly once. `<=`
 * (not `<`): a variable's own calls are always on a strictly later line than its
 * binding statement, so `<=` is safe and tolerant of the rare same-line case.
 */
export function resolveLocalBindingType(
  bindings: Record<string, LocalBinding[]> | undefined,
  varName: string,
  atLine: number,
): string | undefined {
  return resolveLocalBinding(bindings, varName, atLine)?.type;
}

/**
 * Resolve the most-recent `LocalBinding` for `varName` at or before `atLine`,
 * returning the full binding (so callers can inspect `valueKind` and other
 * fields). Returns `undefined` when no binding is established on or before that
 * line. Position-aware lookup shared with `resolveLocalBindingType`.
 */
export function resolveLocalBinding(
  bindings: Record<string, LocalBinding[]> | undefined,
  varName: string,
  atLine: number,
): LocalBinding | undefined {
  const list = bindings?.[varName];
  if (!list || list.length === 0) return undefined;
  let best: LocalBinding | undefined;
  for (const binding of list) {
    // Out of its block's scope (bd tea-rags-mcp-e6xx) — `scopeEndLine` is
    // absent on every binding not scoped narrower than the chunk.
    if (binding.scopeEndLine !== undefined && binding.scopeEndLine < atLine) continue;
    if (binding.line <= atLine && (best === undefined || binding.line > best.line)) best = binding;
  }
  return best;
}

/**
 * A local bound to the RESULT of a call, recorded as the callee SPELLING
 * because its type is not knowable in a per-file pass (bd tea-rags-mcp-z68v9).
 *
 * `repository = SubscriptionRepository.from_session(session)` types
 * `repository` as whatever `from_session` returns — a fact that lives in
 * ANOTHER file's `structuredReturnTypes` and on a class the caller reaches only
 * through the MRO. The walker therefore records
 * `callee: "SubscriptionRepository.from_session"` and the resolver folds it
 * once, at the one layer where the whole symbol table is in scope.
 *
 * Distinct from `localCallBindings` (`Record<string, string>`, bd
 * tea-rags-mcp-6g9c), which Go and Ruby pair with the bare-name-keyed
 * `functionReturnTypes` channel. Python DROPS that channel (one
 * `def get(self) -> Foo` would speak for every `get` in the corpus), so a
 * Python fold needs the whole callee expression, not a short name — hence a
 * second channel rather than a widening of the first.
 */
export interface CallResultBinding {
  /** 1-based line of the assignment. */
  readonly line: number;
  /** The callee as written, arguments stripped: `Repo.from_session`, `self.factory.build`, `make`. */
  readonly callee: string;
}

/**
 * The most-recent {@link CallResultBinding} for `varName` at or before
 * `atLine` — the LAST entry whose `line <= atLine`, `undefined` when none.
 *
 * The rule is {@link resolveLocalBinding}'s verbatim, and it lives beside it so
 * the two position lookups cannot drift: a call site reads whichever binding
 * was established most recently above it, and a later reassignment shadows an
 * earlier one for every call below it.
 */
export function nearestCallResultBinding(
  bindings: Record<string, CallResultBinding[]> | undefined,
  varName: string,
  atLine: number,
): CallResultBinding | undefined {
  const list = bindings?.[varName];
  if (!list || list.length === 0) return undefined;
  let best: CallResultBinding | undefined;
  for (const binding of list) {
    if (binding.line <= atLine && (best === undefined || binding.line > best.line)) best = binding;
  }
  return best;
}
